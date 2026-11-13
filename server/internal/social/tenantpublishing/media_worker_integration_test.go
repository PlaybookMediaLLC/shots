package tenantpublishing

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	productent "github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/lucsky/cuid"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

// privateBucket stands in for the tenant R2 bucket: the backend writes and
// reads objects, and a provider can fetch one only through a signed URL whose
// key is inside the publishing workspace.
type privateBucket struct {
	mu      sync.Mutex
	objects map[string][]byte
	types   map[string]string
	server  *httptest.Server
	signed  int
}

func newPrivateBucket(t *testing.T) *privateBucket {
	b := &privateBucket{objects: map[string][]byte{}, types: map[string]string{}}
	b.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("X-Amz-Signature") != "test-signature" {
			http.Error(w, "unsigned", http.StatusForbidden)
			return
		}
		b.mu.Lock()
		body, ok := b.objects[strings.TrimPrefix(r.URL.Path, "/")]
		mime := b.types[strings.TrimPrefix(r.URL.Path, "/")]
		b.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mime)
		_, _ = w.Write(body)
	}))
	t.Cleanup(b.server.Close)
	return b
}

func (b *privateBucket) SignUpload(_ context.Context, key, mime string) (string, error) {
	b.mu.Lock()
	b.types[key] = mime
	b.mu.Unlock()
	return b.server.URL + "/" + key + "?upload", nil
}
func (b *privateBucket) SignDownload(_ context.Context, key string) (string, error) {
	return b.server.URL + "/" + key + "?X-Amz-Signature=test-signature", nil
}
func (b *privateBucket) Exists(_ context.Context, key string) (bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.objects[key]
	return ok, nil
}
func (b *privateBucket) Put(_ context.Context, key, mime string, body io.Reader) error {
	data, err := io.ReadAll(body)
	b.mu.Lock()
	b.objects[key], b.types[key] = data, mime
	b.mu.Unlock()
	return err
}
func (b *privateBucket) Read(_ context.Context, key string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.objects[key], nil
}
func (b *privateBucket) Delete(_ context.Context, key string) error {
	b.mu.Lock()
	delete(b.objects, key)
	b.mu.Unlock()
	return nil
}

// SignDelivery mirrors media.TenantObjects: a key outside the workspace is refused.
func (b *privateBucket) SignDelivery(_ context.Context, organizationID, key string) (string, error) {
	if !strings.HasPrefix(key, "org/"+organizationID+"/") {
		return "", errors.New("media object is outside the active organization")
	}
	b.mu.Lock()
	b.signed++
	b.mu.Unlock()
	return b.server.URL + "/" + key + "?X-Amz-Signature=test-signature&X-Amz-Expires=86400", nil
}

// receivedMedia is what the test provider fetched from one signed URL.
type receivedMedia struct {
	kind, contentType, sha256, alt string
}

type receivedPost struct {
	caption string
	media   []receivedMedia
	// settings are the provider settings the post carried.
	settings map[string]any
}

// testProvider is the provider peer: it fetches each signed URL the way
// Instagram and Threads do, and returns a receipt, an outright rejection or no
// answer at all.
type testProvider struct {
	mu    sync.Mutex
	posts []receivedPost
	calls int
	fail  error
}

func (p *testProvider) Post(ctx context.Context, _, token string, posts []integrations.PostDetails, account *socialent.Integration) ([]integrations.PostResponse, error) {
	p.mu.Lock()
	p.calls++
	fail := p.fail
	p.mu.Unlock()
	if token != "valid" || len(posts) != 1 {
		return nil, errors.New("unexpected provider input")
	}
	if fail != nil {
		return nil, fail
	}
	received := receivedPost{caption: posts[0].Message}
	if err := json.Unmarshal(posts[0].Settings, &received.settings); err != nil {
		return nil, err
	}
	for _, media := range posts[0].Media {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, media.Path, nil)
		if err != nil {
			return nil, err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("media fetch failed: %d %v", response.StatusCode, err)
		}
		received.media = append(received.media, receivedMedia{kind: media.Type, contentType: response.Header.Get("Content-Type"),
			sha256: fmt.Sprintf("%x", sha256.Sum256(body)), alt: media.Alt})
	}
	p.mu.Lock()
	p.posts = append(p.posts, received)
	id := fmt.Sprintf("remote-%d", len(p.posts))
	p.mu.Unlock()
	receiptURL := ""
	if account.ProviderIdentifier == "tiktok" {
		id = "7234567890123456789"
		receiptURL = "https://www.tiktok.com/@fixture/video/" + id
		// TikTok's receipt for a draft sent to the app (the adapter's SEND_TO_USER_INBOX).
		if received.settings["content_posting_method"] == "UPLOAD" {
			id, receiptURL = "missing", "https://www.tiktok.com/messages?lang=en#v_inbox_file~v2.7234567890123456789"
		}
	}
	if account.ProviderIdentifier == "youtube" {
		receiptURL = "https://www.youtube.com/watch?v=" + id
	}
	return []integrations.PostResponse{{PostID: id, ReleaseURL: receiptURL, Status: "posted"}}, nil
}

func (*testProvider) CreatorInfo(context.Context, string) (*postoptions.TikTokCreator, error) {
	return &postoptions.TikTokCreator{Nickname: "Fixture", PrivacyLevels: []string{"SELF_ONLY"}, MaxDurationSeconds: 300}, nil
}
func (*testProvider) ConfirmVideo(context.Context, string, string, string) (string, error) {
	return "private", nil
}

type unlimitedMeter struct{}

func (unlimitedMeter) Meter(_ context.Context, _ string, amount, limit int64) (quota.MonthlyUsage, error) {
	return quota.MonthlyUsage{Used: amount, Remaining: limit - amount}, nil
}

// One photo, one video, one multi-photo post, a mixed carousel and separate
// photo posts go from upload through the scheduler and PostWorkflowV2 to the
// provider, which fetches the exact private bytes in order; the receipt is
// recorded once. Failures keep their meaning: an unanswered submission is
// UNKNOWN_DELIVERY and is not retried, and a withdrawn approval never reaches
// the provider. The provider peer and the bucket are the only fakes.
func TestScheduledMediaReachesTheProviderThroughTheWorker(t *testing.T) {
	databaseURL := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	socialDB, err := socialdatabase.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = socialDB.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	org, remote, user := "org_"+id, "social_"+id, "user_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, user, id+"@example.test")
	exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Media worker',$1,now())`, org)
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "session_"+id, user, org)
	exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+id, org, user)
	exec(`INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Media worker',now())`, remote)
	exec(`INSERT INTO social_tenant_binding ("organizationId","goOrganizationId","secretReference","createdAt") VALUES ($1,$2,'SOCIAL_API_KEY',now())`, org, remote)
	t.Cleanup(func() {
		for _, cleanup := range []struct{ query, id string }{
			{`DELETE FROM "Integration" WHERE "organizationId"=$1`, remote},
			{`DELETE FROM social_tenant_binding WHERE "organizationId"=$1`, org},
			{`DELETE FROM "Organization" WHERE id=$1`, remote},
			{`DELETE FROM organization WHERE id=$1`, org},
			{`DELETE FROM "user" WHERE id=$1`, user},
		} {
			_, _ = db.SQL.ExecContext(ctx, cleanup.query, cleanup.id)
		}
	})
	owner := product.Actor{OrganizationID: org, UserID: user, SessionID: "session_" + id, RequestID: "request_" + id}
	bucket := newPrivateBucket(t)
	store := product.NewConfiguration(db.Client).WithObjectStore(bucket).WithMonthlyMeter(unlimitedMeter{})
	if _, err := store.SyncWorkspaceEntitlement(ctx, product.EntitlementSyncInput{EventID: "subscribe-" + id, EventType: "test.subscribed",
		OrganizationID: org, Plan: "business", Provider: "test", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	repository := publishing.NewRepository(db.Client)
	connected := map[string]string{}
	connect := func(platform string) string {
		t.Helper()
		if id, ok := connected[platform]; ok {
			return id
		}
		external := platform + "-" + id
		exec(`INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,'Test account',$3,'social','valid')`, external, remote, platform)
		connection, err := repository.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: user, RequestID: owner.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: external, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
		if err != nil {
			t.Fatal(err)
		}
		connected[platform] = connection.ID
		return connection.ID
	}
	linkedin, threads := connect("linkedin"), connect("threads")

	upload := func(fileName, mime string, body []byte) (string, string) {
		t.Helper()
		digest := fmt.Sprintf("%x", sha256.Sum256(body))
		signed, err := store.SignAssetUpload(ctx, owner, product.AssetUploadInput{Bytes: len(body), ContentType: mime, FileName: fileName, SHA256: &digest})
		if err != nil {
			t.Fatal(err)
		}
		bucket.mu.Lock()
		bucket.objects[signed.Asset.ObjectKey] = body
		bucket.mu.Unlock()
		if _, err := store.CompleteAssetUpload(ctx, owner, signed.Asset.ID, &digest); err != nil {
			t.Fatalf("%s: %v", fileName, err)
		}
		return signed.Asset.ID, digest
	}
	photo := func(shade uint8) []byte {
		picture := image.NewRGBA(image.Rect(0, 0, 640, 640))
		for i := range picture.Pix {
			picture.Pix[i] = shade
		}
		picture.Set(1, 1, color.RGBA{R: 255, A: 255})
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, picture); err != nil {
			t.Fatal(err)
		}
		return encoded.Bytes()
	}
	read := func(file string) []byte {
		body, err := os.ReadFile("../../mediavideo/testdata/" + file)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}

	provider := &testProvider{}
	publisher := New(repository, socialDB.Client, bucket)
	publisher.resolve = func(string) poster { return provider }
	store.WithAccountStanding(publisher)
	activities := temporalpublishing.NewActivities(repository, publisher)
	run := func(postID string) temporalpublishing.WorkflowResult {
		t.Helper()
		// The scheduler's timer is real elapsed time; this test moves the due
		// time instead, which proves the worker path, not a long real delay.
		exec(`UPDATE scheduled_post SET "scheduledFor"=now()-interval '1 second' WHERE id=$1`, postID)
		var suite testsuite.WorkflowTestSuite
		env := suite.NewTestWorkflowEnvironment()
		for name, fn := range map[string]any{
			temporalpublishing.PrepareActivityName: activities.Prepare, temporalpublishing.BeginActivityName: activities.Begin,
			temporalpublishing.SubmitActivityName: activities.Submit, temporalpublishing.CompleteActivityName: activities.CompleteV2,
			temporalpublishing.FailActivityName: activities.FailV2, temporalpublishing.MarkUnknownActivityName: activities.MarkUnknown,
			temporalpublishing.PlanAutomationsActivityName: activities.PlanAutomations, temporalpublishing.CheckActivityName: activities.Check,
		} {
			env.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: name})
		}
		env.ExecuteWorkflow(temporalpublishing.PostWorkflowV2, temporalpublishing.WorkflowInput{
			ActivityTaskQueue: temporalpublishing.DefaultActivityQueue, ActivityTimeout: time.Minute, MaxAttempts: 3,
			MainTaskQueue: temporalpublishing.DefaultWorkflowQueue, OrganizationID: org, PostID: postID,
			RetryDelay: time.Minute, ScheduledFor: time.Now(),
		})
		if err := env.GetWorkflowError(); err != nil {
			t.Fatal(err)
		}
		var result temporalpublishing.WorkflowResult
		if err := env.GetWorkflowResult(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	schedule := func(text string, assets []string, targets ...product.ContentDraftScheduleTarget) []*productent.ScheduledPost {
		t.Helper()
		draft, err := store.CreateContentDraft(ctx, owner, product.ContentDraftInput{Title: text, PlainText: text, AssetIDs: assets})
		if err != nil {
			t.Fatal(err)
		}
		result, err := store.ScheduleContentDraft(ctx, owner, draft.ID, product.ScheduleContentDraftInput{
			Version: draft.Version, ScheduledFor: time.Now().Add(2 * time.Minute), Targets: targets})
		if err != nil {
			t.Fatal(err)
		}
		return result.Scheduled
	}
	receipt := func(post *productent.ScheduledPost, remoteID string) {
		t.Helper()
		current := db.Client.ScheduledPost.GetX(ctx, post.ID)
		attempts := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(post.ID)).AllX(ctx)
		if current.Status != scheduledpost.StatusPUBLISHED || current.RemotePostID == nil || *current.RemotePostID != remoteID ||
			len(attempts) != 1 || attempts[0].Outcome == nil || *attempts[0].Outcome != publicationattempt.OutcomeSUCCEEDED ||
			attempts[0].ProviderPostID == nil || *attempts[0].ProviderPostID != remoteID {
			t.Fatalf("receipt: post=%s remote=%v attempts=%+v", current.Status, current.RemotePostID, attempts)
		}
	}
	last := func() receivedPost {
		provider.mu.Lock()
		defer provider.mu.Unlock()
		return provider.posts[len(provider.posts)-1]
	}

	t.Run("one photo with its caption", func(t *testing.T) {
		asset, digest := upload("launch.png", "image/png", photo(40))
		if _, err := store.SetAssetAltText(ctx, owner, asset, "The new dashboard"); err != nil {
			t.Fatal(err)
		}
		caption := "Launch day 🚀\nLine two, with #shots and @team\n— ünïcödé"
		posts := schedule("Photo", []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: linkedin, Caption: caption, AssetIDs: []string{asset}})
		if result := run(posts[0].ID); result.Outcome != temporalpublishing.OutcomePublished {
			t.Fatalf("result %+v", result)
		}
		got := last()
		if got.caption != caption || len(got.media) != 1 || got.media[0] != (receivedMedia{"image", "image/png", digest, "The new dashboard"}) {
			t.Fatalf("provider received %+v", got)
		}
		receipt(posts[0], "remote-1")
		if key := db.Client.Asset.GetX(ctx, asset).ObjectKey; strings.Contains(db.Client.ScheduledPost.GetX(ctx, posts[0].ID).AssetIds[0], "X-Amz") || key == "" {
			t.Fatal("a signed URL was stored instead of the asset")
		}
	})

	t.Run("one video with its caption", func(t *testing.T) {
		asset, digest := upload("clip.mp4", "video/mp4", read("portrait.mp4"))
		posts := schedule("Video", []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: linkedin, Caption: "Watch the demo", AssetIDs: []string{asset}})
		if result := run(posts[0].ID); result.Outcome != temporalpublishing.OutcomePublished {
			t.Fatalf("result %+v", result)
		}
		if got := last(); got.caption != "Watch the demo" || len(got.media) != 1 || got.media[0].kind != "video" || got.media[0].sha256 != digest || got.media[0].contentType != "video/mp4" {
			t.Fatalf("provider received %+v", got)
		}
		receipt(posts[0], "remote-2")
	})

	t.Run("one post with several photos, a mixed carousel, and separate posts", func(t *testing.T) {
		var ids, digests []string
		for shade := uint8(0); shade < 3; shade++ {
			asset, digest := upload(fmt.Sprintf("slide-%d.png", shade), "image/png", photo(60+shade*40))
			ids, digests = append(ids, asset), append(digests, digest)
		}
		// Reordered on purpose: the post keeps the order it was given.
		order := []string{ids[2], ids[0], ids[1]}
		posts := schedule("Carousel", order, product.ContentDraftScheduleTarget{ChannelConnectionID: threads, Caption: "Three slides", AssetIDs: order})
		run(posts[0].ID)
		got := last()
		if len(got.media) != 3 || got.media[0].sha256 != digests[2] || got.media[1].sha256 != digests[0] || got.media[2].sha256 != digests[1] {
			t.Fatalf("carousel order %+v", got.media)
		}
		movie, movieDigest := upload("clip.mov", "video/quicktime", read("rotated.mov"))
		mixed := schedule("Mixed", []string{ids[0], movie}, product.ContentDraftScheduleTarget{ChannelConnectionID: threads, Caption: "Photo then clip", AssetIDs: []string{ids[0], movie}})
		run(mixed[0].ID)
		if got := last(); len(got.media) != 2 || got.media[0].kind != "image" || got.media[1] != (receivedMedia{"video", "video/quicktime", movieDigest, ""}) {
			t.Fatalf("mixed carousel %+v", got.media)
		}
		before := len(provider.posts)
		for i, asset := range ids {
			separate := schedule(fmt.Sprintf("Separate %d", i), []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: threads, Caption: fmt.Sprintf("Post %d", i), AssetIDs: []string{asset}})
			run(separate[0].ID)
		}
		if len(provider.posts) != before+3 {
			t.Fatalf("separate posts made %d provider posts", len(provider.posts)-before)
		}
		for i, post := range provider.posts[before:] {
			if len(post.media) != 1 || post.media[0].sha256 != digests[i] || post.caption != fmt.Sprintf("Post %d", i) {
				t.Fatalf("separate post %d: %+v", i, post)
			}
		}
	})

	for _, platform := range []string{"tiktok", "youtube"} {
		t.Run(platform+" video snapshot and final receipt", func(t *testing.T) {
			connection := connect(platform)
			asset, digest := upload(platform+".mp4", "video/mp4", read("portrait.mp4"))
			options := &postoptions.PublishOptions{}
			if platform == "tiktok" {
				options.TikTok = &postoptions.TikTokOptions{Privacy: "SELF_ONLY", Consent: true}
			} else {
				audience := false
				options.YouTube = &postoptions.YouTubeOptions{Title: "Worker video", Privacy: "private", MadeForKids: &audience}
			}
			posts := schedule(platform, []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: connection, Caption: "Video worker proof", AssetIDs: []string{asset}, Options: options})
			stored := db.Client.ScheduledPost.GetX(ctx, posts[0].ID)
			if !reflect.DeepEqual(stored.PublishOptions.TikTok, options.TikTok) || !reflect.DeepEqual(stored.PublishOptions.YouTube, options.YouTube) {
				t.Fatal("video options not persisted")
			}
			if result := run(posts[0].ID); result.Outcome != temporalpublishing.OutcomePublished {
				t.Fatalf("result %+v", result)
			}
			if got := last(); len(got.media) != 1 || got.media[0].sha256 != digest || got.media[0].contentType != "video/mp4" {
				t.Fatalf("wrong video bytes: %+v", got)
			}
			stored = db.Client.ScheduledPost.GetX(ctx, posts[0].ID)
			if stored.ThreadProgress.Publication == nil || stored.ThreadProgress.Publication.URL == "" {
				t.Fatal("final URL not retained")
			}
			receipt(posts[0], *stored.RemotePostID)
			before := provider.calls
			run(posts[0].ID)
			if provider.calls != before {
				t.Fatal("duplicate video mutation")
			}
		})
	}

	t.Run("a TikTok app draft is sent to the app and never published", func(t *testing.T) {
		connection := connect("tiktok")
		asset, digest := upload("draft.mp4", "video/mp4", read("portrait.mp4"))
		posts := schedule("App draft", []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: connection, Caption: "Finish me in TikTok",
			AssetIDs: []string{asset}, Options: &postoptions.PublishOptions{TikTok: &postoptions.TikTokOptions{SendToApp: true}}})
		run(posts[0].ID)
		got := last()
		// TikTok takes only the caption with an app draft: no privacy or consent goes out.
		if got.caption != "Finish me in TikTok" || len(got.media) != 1 || got.media[0].sha256 != digest ||
			!reflect.DeepEqual(got.settings, map[string]any{"content_posting_method": "UPLOAD"}) {
			t.Fatalf("provider received %+v", got)
		}
		current := db.Client.ScheduledPost.GetX(ctx, posts[0].ID)
		attempts := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(posts[0].ID)).AllX(ctx)
		if current.Status != scheduledpost.StatusSENT_TO_APP || current.PublishedAt != nil || current.RemotePostID == nil ||
			*current.RemotePostID != "v_inbox_file~v2.7234567890123456789" || current.ThreadProgress.Publication != nil ||
			len(attempts) != 1 || *attempts[0].Outcome != publicationattempt.OutcomeSUCCEEDED || attempts[0].RemoteURL != nil {
			t.Fatalf("app draft: status=%s published=%v remote=%v progress=%+v attempts=%+v", current.Status, current.PublishedAt, current.RemotePostID, current.ThreadProgress, attempts)
		}
		var sent, published int
		if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE type='activity.post.sent_to_app'), count(*) FILTER (WHERE type='activity.post.published')
			FROM outbox_event WHERE "organizationId"=$1 AND "aggregateId"=$2`, org, posts[0].ID).Scan(&sent, &published); err != nil || sent != 1 || published != 0 {
			t.Fatalf("activity sent=%d published=%d err=%v", sent, published, err)
		}
		before := provider.calls
		run(posts[0].ID)
		if provider.calls != before {
			t.Fatal("an app draft was sent twice")
		}
	})

	t.Run("an unanswered submission is UNKNOWN_DELIVERY and is not retried", func(t *testing.T) {
		asset, _ := upload("lost.png", "image/png", photo(200))
		posts := schedule("Lost", []string{asset}, product.ContentDraftScheduleTarget{ChannelConnectionID: linkedin, Caption: "Response lost", AssetIDs: []string{asset}})
		provider.mu.Lock()
		provider.fail, provider.calls = &url.Error{Op: "Post", URL: "https://provider.example", Err: context.DeadlineExceeded}, 0
		provider.mu.Unlock()
		t.Cleanup(func() { provider.fail = nil })
		result := run(posts[0].ID)
		current := db.Client.ScheduledPost.GetX(ctx, posts[0].ID)
		attempts := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(posts[0].ID)).AllX(ctx)
		if result.Outcome == temporalpublishing.OutcomePublished || current.Status != scheduledpost.StatusUNKNOWN_DELIVERY || provider.calls != 1 ||
			len(attempts) != 1 || attempts[0].FailureCode == nil || *attempts[0].FailureCode != "UNKNOWN_DELIVERY" {
			t.Fatalf("result=%+v status=%s calls=%d attempts=%+v", result, current.Status, provider.calls, attempts)
		}
	})

	t.Run("a withdrawn approval never reaches the provider", func(t *testing.T) {
		provider.fail = nil
		required := true
		if _, err := store.UpdateContentDraftSettings(ctx, owner, product.ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		asset, _ := upload("held.png", "image/png", photo(220))
		draft, err := store.CreateContentDraft(ctx, owner, product.ContentDraftInput{Title: "Held", PlainText: "Held", AssetIDs: []string{asset}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReviewContentDraft(ctx, owner, draft.ID, product.ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		scheduled, err := store.ScheduleContentDraft(ctx, owner, draft.ID, product.ScheduleContentDraftInput{Version: draft.Version, ScheduledFor: time.Now().Add(2 * time.Minute),
			Targets: []product.ContentDraftScheduleTarget{{ChannelConnectionID: linkedin, Caption: "Held", AssetIDs: []string{asset}}}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReviewContentDraft(ctx, owner, draft.ID, product.ContentDraftReviewInput{Version: scheduled.Draft.Version, Action: "changes"}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReviewContentDraft(ctx, owner, draft.ID, product.ContentDraftReviewInput{Version: scheduled.Draft.Version, Action: "request"}); err != nil {
			t.Fatal(err)
		}
		before := provider.calls
		run(scheduled.Scheduled[0].ID)
		if current := db.Client.ScheduledPost.GetX(ctx, scheduled.Scheduled[0].ID); current.Status != scheduledpost.StatusCANCELLED || provider.calls != before {
			t.Fatalf("status=%s provider calls=%d", current.Status, provider.calls-before)
		}
	})
}

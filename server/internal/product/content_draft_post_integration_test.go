package product

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// postFixture is a paying workspace with a publishing key and connected accounts.
type postFixture struct {
	*testWorkspace
	key    Actor
	x      string
	li     string
	meter  *recordingMonthlyMeter
	future time.Time
}

func newPostFixture(t *testing.T) *postFixture {
	t.Helper()
	w := newTestWorkspace(t)
	meter := &recordingMonthlyMeter{}
	w.repo.WithMonthlyMeter(meter)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	add := socialCredentialFixture(t, w.ctx, w.db.SQL, w.org)
	connect := func(platform string) string {
		external := platform + "-" + w.id
		add(external, platform)
		connection, err := w.repo.auth.CreateConnection(w.ctx, publishing.Actor{Organization: w.org, UserID: w.owner.UserID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: external, Platform: platform, SecretReference: "SOCIAL_API_KEY", ProviderSettings: map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	return &postFixture{testWorkspace: w, key: postKey(t, w, "publish", `{"artifact":["read"],"post":["publish"]}`), x: connect("x"), li: connect("linkedin"), meter: meter,
		future: time.Now().Add(24 * time.Hour).UTC().Truncate(time.Second)}
}

func postKey(t *testing.T, w *testWorkspace, label, permissions string) Actor {
	t.Helper()
	id := "key_" + label + "_" + w.id
	w.exec(t, `INSERT INTO apikey (id,name,"referenceId",key,enabled,permissions,"createdAt","updatedAt") VALUES ($1,'Agent',$2,$3,true,$4,now(),now())`, id, w.org, "hashed-"+id, permissions)
	return Actor{Kind: "api_key", KeyID: id, OrganizationID: w.org, Display: "Agent", RequestID: "request-" + w.id}
}

func (f *postFixture) input(text string, connections ...string) CreatePostInput {
	return CreatePostInput{ChannelConnectionIDs: connections, IdempotencyKey: "agent-post-" + f.id + "-" + text,
		Posts: []PostPart{{Text: text}}, ScheduledFor: f.future}
}

func (f *postFixture) drafts(t *testing.T) int {
	t.Helper()
	count, err := f.db.Client.ContentDraft.Query().Where(contentdraft.OrganizationID(f.org)).Count(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	return count
}

// Only post:publish posts: a key issued with post:schedule was promised it could
// schedule only what a person approved, and draft:write only ever wrote drafts.
func TestCreatePostNeedsItsOwnScope(t *testing.T) {
	f := newPostFixture(t)
	for label, permissions := range map[string]string{
		"schedule": `{"artifact":["read"],"post":["schedule"]}`,
		"draft":    `{"artifact":["read"],"draft":["write"],"upload":["sign"],"asset":["write"]}`,
	} {
		_, err := f.repo.CreatePost(f.ctx, postKey(t, f.testWorkspace, label, permissions), f.input("Refused", f.x))
		if !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("%s key: %v", label, err)
		}
	}
	f.addMember(t, "viewer", "viewer")
	if _, err := f.repo.CreatePost(f.ctx, f.actor("viewer"), f.input("Refused", f.x)); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer: %v", err)
	}
	if count := f.drafts(t); count != 0 {
		t.Fatalf("refused posts left %d drafts", count)
	}
}

// A stored draft still takes a person: post:publish opens only CreatePost.
func TestPublishScopeDoesNotOpenDraftScheduling(t *testing.T) {
	f := newPostFixture(t)
	draft, err := f.repo.CreateContentDraft(f.ctx, f.owner, ContentDraftInput{Title: "A person's draft"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.repo.ScheduleContentDraft(f.ctx, f.key, draft.ID, ScheduleContentDraftInput{Version: draft.Version, ScheduledFor: f.future,
		Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: f.x, Caption: "Sneaked"}}})
	if !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("key scheduled a stored draft: %v", err)
	}
}

func TestCreatePostSchedulesAndARetryPostsOnce(t *testing.T) {
	f := newPostFixture(t)
	// LinkedIn first: neither the idempotency keys' order nor the table's may decide the answer.
	input := f.input("Shipped the new editor", f.li, f.x)
	first, err := f.repo.CreatePost(f.ctx, f.key, input)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Created || first.Status != PostStatusScheduled || len(first.Posts) != 2 || len(first.Scheduled) != 2 {
		t.Fatalf("first: %+v", first)
	}
	for _, post := range first.Scheduled {
		if post.Caption != "Shipped the new editor" || !post.ScheduledFor.Equal(f.future) || post.Status != scheduledpost.StatusSCHEDULED {
			t.Fatalf("post: %+v", post)
		}
	}
	if first.Draft.Status != string(contentdraft.StatusScheduled) || len(first.Draft.Body) != 2 {
		t.Fatalf("draft: %+v", first.Draft)
	}
	charged := f.meter.used
	// A post written since, as its workflow starting does, moves in the table but not in the answer.
	f.exec(t, `UPDATE scheduled_post SET "updatedAt"=now() WHERE id=$1`, first.Posts[0].ID)
	retry, err := f.repo.CreatePost(f.ctx, f.key, input)
	if err != nil {
		t.Fatal(err)
	}
	if retry.Created || retry.Draft.ID != first.Draft.ID || len(retry.Posts) != 2 || retry.Posts[0].ID != first.Posts[0].ID || retry.Posts[1].ID != first.Posts[1].ID {
		t.Fatalf("retry: %+v", retry)
	}
	total := 0
	for _, used := range charged {
		total += int(used)
	}
	if total != 2 {
		t.Fatalf("charged %d posts", total)
	}
	input.Posts = []PostPart{{Text: "Something else"}}
	if _, err := f.repo.CreatePost(f.ctx, f.key, input); err == nil || !strings.Contains(err.Error(), "already used") {
		t.Fatalf("reused key with new text: %v", err)
	}
	if count := f.drafts(t); count != 1 {
		t.Fatalf("drafts=%d", count)
	}
}

func TestCreatePostPublishNowThreadAndPerPlatformText(t *testing.T) {
	f := newPostFixture(t)
	input := f.input("Short for X", f.x, f.li)
	input.ScheduledFor, input.PublishNow = time.Time{}, true
	input.Posts = []PostPart{{Text: "First"}, {Text: "Second"}}
	input.Platforms = map[string]PostPlatform{"linkedin": {
		Options: &PostOptions{FirstComment: "Link in the comments"}, Posts: []PostPart{{Text: "Longer\n\nfor LinkedIn"}},
	}}
	result, err := f.repo.CreatePost(f.ctx, f.key, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != PostStatusPublishing {
		t.Fatalf("status=%s", result.Status)
	}
	byConnection := map[string]int{}
	for at, post := range result.Scheduled {
		byConnection[post.ChannelConnectionID] = at
		if post.ScheduledFor.After(time.Now()) {
			t.Fatalf("publish now was queued for %v", post.ScheduledFor)
		}
	}
	x, li := result.Scheduled[byConnection[f.x]], result.Scheduled[byConnection[f.li]]
	if x.Caption != "First" || len(x.Replies) != 1 || x.Replies[0].Caption != "Second" {
		t.Fatalf("x: %+v", x)
	}
	if li.Caption != "Longer\n\nfor LinkedIn" || len(li.Replies) != 0 || li.PublishOptions.FirstComment != "Link in the comments" {
		t.Fatalf("linkedin: %+v", li)
	}
	row, err := f.db.Client.ContentDraft.Get(f.ctx, result.Draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(row.PlatformVersions.Versions) != 1 || row.PlatformVersions.Versions[0].Channel != "linkedin" || len(row.PlatformVersions.Versions[0].Body) != 3 {
		t.Fatalf("draft should keep LinkedIn's own text: %+v", row.PlatformVersions)
	}
}

// Whatever a schedule would refuse is refused first, so an agent's failed
// attempts don't fill the workspace with drafts.
func TestRefusedPostsLeaveNoDraft(t *testing.T) {
	f := newPostFixture(t)
	missing := cuid.New()
	for name, change := range map[string]func(*CreatePostInput){
		"no time":            func(i *CreatePostInput) { i.ScheduledFor = time.Time{} },
		"two times":          func(i *CreatePostInput) { i.PublishNow = true },
		"past":               func(i *CreatePostInput) { i.ScheduledFor = time.Now().Add(-time.Hour) },
		"no key":             func(i *CreatePostInput) { i.IdempotencyKey = "" },
		"no posts":           func(i *CreatePostInput) { i.Posts = nil },
		"no accounts":        func(i *CreatePostInput) { i.ChannelConnectionIDs = nil },
		"unknown account":    func(i *CreatePostInput) { i.ChannelConnectionIDs = []string{missing} },
		"same account twice": func(i *CreatePostInput) { i.ChannelConnectionIDs = []string{f.x, f.x} },
		"over the limit":     func(i *CreatePostInput) { i.Posts = []PostPart{{Text: strings.Repeat("a", 281)}} },
		"thread on LinkedIn": func(i *CreatePostInput) {
			i.ChannelConnectionIDs = []string{f.li}
			i.Posts = []PostPart{{Text: "a"}, {Text: "b"}}
		},
		"unmatched override": func(i *CreatePostInput) {
			i.Platforms = map[string]PostPlatform{"linkedin": {Posts: []PostPart{{Text: "b"}}}}
		},
		"unknown asset": func(i *CreatePostInput) { i.Posts = []PostPart{{Text: "a", AssetIDs: []string{missing}}} },
		"comment on X": func(i *CreatePostInput) {
			i.Platforms = map[string]PostPlatform{"x": {Options: &PostOptions{FirstComment: "No"}}}
		},
		"empty post": func(i *CreatePostInput) { i.Posts = []PostPart{{Text: "  "}} },
	} {
		t.Run(name, func(t *testing.T) {
			input := f.input("A post", f.x)
			change(&input)
			if result, err := f.repo.CreatePost(f.ctx, f.key, input); err == nil {
				t.Fatalf("accepted: %+v", result)
			}
			if count := f.drafts(t); count != 0 {
				t.Fatalf("left %d drafts", count)
			}
		})
	}
}

// A key sees shared sets only. A person's private set is not found, the same
// as an account in another workspace, and accounts of two sets are one post each.
func TestCreatePostKeepsPrivateSetsAndOtherWorkspacesOut(t *testing.T) {
	f := newPostFixture(t)
	other := newPostFixture(t)
	if _, err := f.repo.CreatePost(f.ctx, f.key, f.input("Foreign", other.x)); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign account: %v", err)
	}
	private := cuid.New()
	f.exec(t, `INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","ownerUserId","createdAt","updatedAt") VALUES ($1,$2,'Mine','PRIVATE',$1,$3,now(),now())`, private, f.org, f.owner.UserID)
	f.exec(t, `UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, private, f.x)
	if _, err := f.repo.CreatePost(f.ctx, f.key, f.input("Private", f.x)); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("private set: %v", err)
	}
	if _, err := f.repo.CreatePost(f.ctx, f.key, f.input("Two sets", f.x, f.li)); err == nil {
		t.Fatal("posted across sets")
	}
	if count := f.drafts(t); count != 0 {
		t.Fatalf("left %d drafts", count)
	}
	// The set's owner can still post there; privacy limits keys, not people.
	if _, err := f.repo.CreatePost(f.ctx, f.owner, f.input("Mine", f.x)); err != nil {
		t.Fatalf("owner: %v", err)
	}
}

// Require approval holds for agents: the draft waits, and nothing is queued.
func TestCreatePostWaitsWhereTheWorkspaceRequiresApproval(t *testing.T) {
	f := newPostFixture(t)
	required := true
	if _, err := f.repo.UpdateContentDraftSettings(f.ctx, f.owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
		t.Fatal(err)
	}
	input := f.input("Needs a look", f.x)
	input.ScheduledFor, input.PublishNow = time.Time{}, true
	result, err := f.repo.CreatePost(f.ctx, f.key, input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != PostStatusAwaitingApproval || result.ReviewPath != "/publish/"+result.Draft.ID || result.Created || len(result.Posts) != 0 {
		t.Fatalf("result: %+v", result)
	}
	count, err := f.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(result.Draft.ID)).Count(f.ctx)
	if err != nil || count != 0 {
		t.Fatalf("queued %d posts: %v", count, err)
	}
	again, err := f.repo.CreatePost(f.ctx, f.key, input)
	if err != nil || again.Draft.ID != result.Draft.ID || again.Status != PostStatusAwaitingApproval {
		t.Fatalf("retry: %+v %v", again, err)
	}
}

// Private sets are session-only: a key can't read or cancel the posts in one,
// even when it holds the scheduling scope. People keep their own access.
func TestKeysCannotReachPostsInPrivateSets(t *testing.T) {
	f := newPostFixture(t)
	private := cuid.New()
	f.exec(t, `INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","ownerUserId","createdAt","updatedAt") VALUES ($1,$2,'Mine','PRIVATE',$1,$3,now(),now())`, private, f.org, f.owner.UserID)
	f.exec(t, `UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, private, f.x)
	result, err := f.repo.CreatePost(f.ctx, f.owner, f.input("Private plans", f.x))
	if err != nil {
		t.Fatal(err)
	}
	postID := result.Posts[0].ID
	key := postKey(t, f.testWorkspace, "schedule", `{"artifact":["read"],"post":["schedule"]}`)
	listed, err := f.repo.ListScheduledPosts(f.ctx, key, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, post := range listed {
		if post.ID == postID {
			t.Fatal("a key read a post in a private set")
		}
	}
	if _, err := f.repo.CancelScheduledPost(f.ctx, key, postID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("key cancel: %v", err)
	}
	mine, err := f.repo.ListScheduledPosts(f.ctx, f.owner, 50)
	if err != nil || len(mine) != 1 || mine[0].ID != postID {
		t.Fatalf("owner list: %v %v", mine, err)
	}
	if _, err := f.repo.CancelScheduledPost(f.ctx, f.owner, postID); err != nil {
		t.Fatalf("owner cancel: %v", err)
	}
}

// Cancelling a draft's last post puts it back to a draft, so it isn't stuck
// showing as scheduled; a post still queued keeps it scheduled.
func TestCancellingTheLastPostReopensItsDraft(t *testing.T) {
	f := newPostFixture(t)
	key := postKey(t, f.testWorkspace, "both", `{"artifact":["read"],"post":["publish","schedule"]}`)
	result, err := f.repo.CreatePost(f.ctx, key, f.input("Changed my mind", f.x, f.li))
	if err != nil {
		t.Fatal(err)
	}
	status := func() contentdraft.Status {
		t.Helper()
		row, err := f.db.Client.ContentDraft.Get(f.ctx, result.Draft.ID)
		if err != nil {
			t.Fatal(err)
		}
		return row.Status
	}
	if _, err := f.repo.CancelScheduledPost(f.ctx, key, result.Posts[0].ID); err != nil {
		t.Fatal(err)
	}
	if got := status(); got != contentdraft.StatusScheduled {
		t.Fatalf("one post still queued, status=%s", got)
	}
	if _, err := f.repo.CancelScheduledPost(f.ctx, key, result.Posts[1].ID); err != nil {
		t.Fatal(err)
	}
	if got := status(); got != contentdraft.StatusDraft {
		t.Fatalf("every post cancelled, status=%s", got)
	}
	// A retry of the same request still doesn't post again.
	retry, err := f.repo.CreatePost(f.ctx, key, f.input("Changed my mind", f.x, f.li))
	if err != nil {
		t.Fatal(err)
	}
	if retry.Created || len(retry.Scheduled) != 0 {
		t.Fatalf("retry revived cancelled posts: %+v", retry)
	}
}

type recordingDeletions struct {
	started []string
	fail    bool
}

func (r *recordingDeletions) StartDelete(_ context.Context, organizationID, postID, _ string) error {
	if r.fail {
		return errors.New("temporal is down")
	}
	r.started = append(r.started, organizationID+"/"+postID)
	return nil
}

// Only a live post is deleted, by the people who may publish it or a key with
// post:delete. Each allowed request is audited and starts the workflow.
func TestDeleteContentDraftPost(t *testing.T) {
	f := newPostFixture(t)
	created, err := f.repo.CreatePost(f.ctx, f.key, f.input("Going away", f.x))
	if err != nil {
		t.Fatal(err)
	}
	postID := created.Posts[0].ID
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, postID); !errors.Is(err, ErrPostDeletionNotStarted) {
		t.Fatalf("without a starter: %v", err)
	}
	starter := &recordingDeletions{fail: true}
	f.repo.WithPostDeletions(starter)
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, postID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("scheduled post: %v", err)
	}
	f.exec(t, `UPDATE scheduled_post SET status='PUBLISHED', "remotePostId"='tweet-1' WHERE id=$1`, postID)
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, postID); !errors.Is(err, ErrPostDeletionNotStarted) {
		t.Fatalf("start failed: %v", err)
	}
	starter = &recordingDeletions{}
	f.repo.WithPostDeletions(starter)
	f.addMember(t, "viewer", "viewer")
	for name, actor := range map[string]Actor{"viewer": f.actor("viewer"), "publish key": f.key} {
		if _, err := f.repo.DeleteContentDraftPost(f.ctx, actor, postID); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, "missing"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("missing post: %v", err)
	}
	key := postKey(t, f.testWorkspace, "delete", `{"post":["delete"]}`)
	// A key does not reach an account in a person's private set.
	var shared *string
	if err := f.db.SQL.QueryRowContext(f.ctx, `SELECT "socialSetId" FROM channel_connection WHERE id=$1`, f.x).Scan(&shared); err != nil {
		t.Fatal(err)
	}
	private := cuid.New()
	f.exec(t, `INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","ownerUserId","createdAt","updatedAt") VALUES ($1,$2,'Mine','PRIVATE',$1,$3,now(),now())`, private, f.org, f.owner.UserID)
	f.exec(t, `UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, private, f.x)
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, key, postID); !errors.Is(err, publishing.ErrNotFound) || len(starter.started) != 0 {
		t.Fatalf("private set: %v", err)
	}
	f.exec(t, `UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, shared, f.x)
	request, err := f.repo.DeleteContentDraftPost(f.ctx, key, postID)
	if err != nil || request.PostID != postID || request.Platform != "x" || len(starter.started) != 1 || starter.started[0] != f.org+"/"+postID {
		t.Fatalf("request=%+v err=%v started=%v", request, err, starter.started)
	}
	audits, err := f.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(f.org), auditlog.Action("post.delete_requested")).Count(f.ctx)
	if err != nil || audits != 2 {
		t.Fatalf("audits=%d err=%v", audits, err)
	}
	// The post lists each part's receipt.
	f.exec(t, `INSERT INTO post_deletion (id,"organizationId","scheduledPostId",key,kind,"remoteId","requestedBy",status,"failureCode",attempts)
		VALUES ($1,$2,$3,'root','post','tweet-1','agent','failed','http_403',1)`, "deletion_"+f.id, f.org, postID)
	listed, err := f.repo.ListContentDraftPosts(f.ctx, f.owner, created.Draft.ID)
	if err != nil || len(listed) != 1 || len(listed[0].Deletions) != 1 || listed[0].Deletions[0].Status != "failed" ||
		listed[0].Deletions[0].FailureCode == nil || *listed[0].Deletions[0].FailureCode != "http_403" {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	// A deleted post with a part left takes a retry; once every part is settled it does not.
	f.exec(t, `UPDATE scheduled_post SET "deletedAt"=now() WHERE id=$1`, postID)
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, postID); err != nil || len(starter.started) != 2 {
		t.Fatalf("retry of a failed part: %v, started=%v", err, starter.started)
	}
	var status string
	var code *string
	if err := f.db.SQL.QueryRowContext(f.ctx, `SELECT status, "failureCode" FROM post_deletion WHERE "scheduledPostId"=$1`, postID).Scan(&status, &code); err != nil || status != "pending" || code != nil {
		t.Fatalf("retried part %s %v: %v", status, code, err)
	}
	f.exec(t, `UPDATE post_deletion SET status='done' WHERE "scheduledPostId"=$1`, postID)
	if _, err := f.repo.DeleteContentDraftPost(f.ctx, f.owner, postID); !errors.Is(err, publishing.ErrConflict) || len(starter.started) != 2 {
		t.Fatalf("deleted post: %v, started=%v", err, starter.started)
	}
}

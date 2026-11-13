package bluesky

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

var testMP4 = []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'm', 'p', '4', '2', 0, 0, 0, 0, 'm', 'p', '4', '2', 'i', 's', 'o', 'm'}

type fakePDS struct {
	*httptest.Server
	mu       sync.Mutex
	records  []map[string]any
	uploads  int
	override func(http.ResponseWriter, *http.Request) bool
}

func newFakePDS(t *testing.T) *fakePDS {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	t.Setenv("JWT_SECRET", "test-secret")
	f := &fakePDS{}
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 40, 20)))
	pngBytes := buf.Bytes()

	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if f.override != nil && f.override(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/xrpc/com.atproto.server.createSession":
			var in map[string]string
			_ = json.Unmarshal(body, &in)
			if in["password"] != "app-password" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"error":"AuthenticationRequired","message":"Invalid identifier or password"}`))
				return
			}
			_, _ = w.Write([]byte(`{"accessJwt":"access","refreshJwt":"refresh","handle":"me.bsky.social","did":"did:plc:abcdefghijklmnopqrstuvwx",
				"didDoc":{"id":"did:plc:abcdefghijklmnopqrstuvwx","service":[{"id":"#atproto_pds","type":"AtprotoPersonalDataServer","serviceEndpoint":"` + f.URL + `/pds"}]}}`))
		case "/xrpc/app.bsky.actor.getProfile":
			_, _ = w.Write([]byte(`{"did":"did:plc:abcdefghijklmnopqrstuvwx","handle":"me.bsky.social","displayName":"Me","avatar":"https://cdn/avatar.jpg"}`))
		case "/xrpc/com.atproto.identity.resolveHandle":
			if r.URL.Query().Get("handle") != "alice.bsky.social" {
				w.WriteHeader(400)
				_, _ = w.Write([]byte(`{"error":"InvalidRequest","message":"Unable to resolve handle"}`))
				return
			}
			_, _ = w.Write([]byte(`{"did":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"}`))
		case "/xrpc/com.atproto.repo.uploadBlob":
			f.mu.Lock()
			f.uploads++
			f.mu.Unlock()
			_, _ = w.Write([]byte(`{"blob":{"$type":"blob","ref":{"$link":"bafkimage"},"mimeType":"image/png","size":` + "100" + `}}`))
		case "/xrpc/com.atproto.repo.createRecord":
			if r.Header.Get("Authorization") != "Bearer access" {
				w.WriteHeader(401)
				return
			}
			var in map[string]any
			_ = json.Unmarshal(body, &in)
			if in["record"].(map[string]any)["text"] == "reject" {
				w.WriteHeader(408) // unknown to xrpc: becomes 400
				_, _ = w.Write([]byte(`{"error":"InvalidRecord","message":"bad"}`))
				return
			}
			f.mu.Lock()
			f.records = append(f.records, in)
			f.mu.Unlock()
			_, _ = w.Write([]byte(`{"uri":"at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3kpost","cid":"bafypost"}`))
		case "/xrpc/app.bsky.feed.getPostThread":
			_, _ = w.Write([]byte(`{"thread":{"post":{"uri":"` + r.URL.Query().Get("uri") + `","cid":"bafyparent","likeCount":5,
				"record":{"reply":{"root":{"uri":"at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/root","cid":"bafyroot"}}}}}}`))
		case "/xrpc/com.atproto.server.getServiceAuth":
			_, _ = w.Write([]byte(`{"token":"service-token"}`))
		case "/xrpc/app.bsky.video.getUploadLimits":
			_, _ = w.Write([]byte(`{"canUpload":true,"remainingDailyVideos":10,"remainingDailyBytes":1000000000}`))
		case "/xrpc/app.bsky.video.uploadVideo":
			if r.Header.Get("Authorization") != "Bearer service-token" || r.URL.Query().Get("did") != "did:plc:abcdefghijklmnopqrstuvwx" || !bytes.Equal(body, testMP4) {
				w.WriteHeader(400)
				return
			}
			_, _ = w.Write([]byte(`{"jobId":"job1","did":"did:plc:abcdefghijklmnopqrstuvwx","state":"JOB_STATE_CREATED"}`))
		case "/xrpc/app.bsky.video.getJobStatus":
			_, _ = w.Write([]byte(`{"jobStatus":{"jobId":"job1","did":"did:plc:abcdefghijklmnopqrstuvwx","state":"JOB_STATE_COMPLETED","blob":{"$type":"blob","ref":{"$link":"bafkvideo"},"mimeType":"video/mp4","size":3}}}`))
		case "/media/image.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBytes)
		case "/media/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			_, _ = w.Write(testMP4)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.Close)
	oldVideo, oldPoll, oldVideoPoll, oldPlug := videoServiceURL, pollInterval, videoPollInterval, plugDelay
	t.Cleanup(func() {
		videoServiceURL, pollInterval, videoPollInterval, plugDelay = oldVideo, oldPoll, oldVideoPoll, oldPlug
	})
	videoServiceURL = f.URL
	pollInterval, videoPollInterval, plugDelay = time.Millisecond, time.Millisecond, time.Millisecond
	return f
}

func (f *fakePDS) integration(t *testing.T, password string) *ent.Integration {
	t.Helper()
	details, err := json.Marshal(credentials{Service: f.URL, Identifier: "me.bsky.social", Password: password})
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := helpers.FixedEncryption(string(details))
	if err != nil {
		t.Fatal(err)
	}
	caps := socialidentity.BlueskyLexiconLimits()
	allowed := true
	caps.VideoCanUpload = &allowed
	proof := socialidentity.Capabilities{Version: 1, Bluesky: &caps}
	key, kind, verifiedAt := "bluesky:did:plc:abcdefghijklmnopqrstuvwx", "profile", time.Now()
	return &ent.Integration{InternalID: "did:plc:abcdefghijklmnopqrstuvwx", CustomInstanceDetails: &encrypted,
		VerifiedAccountKey: &key, VerifiedAccountKind: &kind, VerifiedCapabilities: &proof,
		VerifiedScopes: []string{"com.atproto.appPass"}, IdentityVerifiedAt: &verifiedAt}
}

func TestPostWithImageFacetsAndHandshake(t *testing.T) {
	f := newFakePDS(t)
	p := newProvider(f.Client())
	integration := f.integration(t, "app-password")
	posts := []integrations.PostDetails{{
		ID:      "post1",
		Message: "hé @alice.bsky.social and @bob.bsky.social #go",
		Media:   []integrations.MediaContent{{Type: "image", Path: f.URL + "/media/image.png", Alt: "a picture"}},
	}}

	res, err := p.Post(context.Background(), "did:plc:abcdefghijklmnopqrstuvwx", "", posts, integration)
	if err != nil {
		t.Fatal(err)
	}
	if res[0].PostID != "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3kpost" || res[0].ReleaseURL != "https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3kpost" || res[0].Status != "completed" {
		t.Fatalf("unexpected response %+v", res[0])
	}
	if len(f.records) != 1 || f.uploads != 1 {
		t.Fatalf("want one record and one upload, got %d and %d", len(f.records), f.uploads)
	}
	rec := f.records[0]
	if rec["repo"] != "did:plc:abcdefghijklmnopqrstuvwx" || rec["collection"] != "app.bsky.feed.post" {
		t.Fatalf("unexpected createRecord %v", rec)
	}
	record := rec["record"].(map[string]any)
	facets, _ := json.Marshal(record["facets"])
	// "hé " is 4 bytes: the mention starts at byte 4; the unresolved handle
	// keeps an empty did.
	want := `[{"$type":"app.bsky.richtext.facet","features":[{"$type":"app.bsky.richtext.facet#mention","did":"did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"}],"index":{"byteEnd":22,"byteStart":4}},` +
		`{"$type":"app.bsky.richtext.facet","features":[{"$type":"app.bsky.richtext.facet#mention","did":""}],"index":{"byteEnd":43,"byteStart":27}},` +
		`{"features":[{"$type":"app.bsky.richtext.facet#tag","tag":"go"}],"index":{"byteEnd":47,"byteStart":44}}]`
	if string(facets) != want {
		t.Fatalf("facets\n got %s\nwant %s", facets, want)
	}
	embed, _ := json.Marshal(record["embed"])
	wantEmbed := `{"$type":"app.bsky.embed.images","images":[{"alt":"a picture","aspectRatio":{"height":20,"width":40},"image":{"$type":"blob","mimeType":"image/png","ref":{"$link":"bafkimage"},"size":100}}]}`
	if string(embed) != wantEmbed {
		t.Fatalf("embed\n got %s\nwant %s", embed, wantEmbed)
	}
}

func TestVideoPendingFlow(t *testing.T) {
	f := newFakePDS(t)
	p := newProvider(f.Client())
	integration := f.integration(t, "app-password")
	ctx := context.Background()
	res, err := p.PostPending(ctx, "", "", []integrations.PostDetails{{ID: "p", Message: "video", Media: []integrations.MediaContent{{Type: "video", Path: f.URL + "/media/video.mp4"}}}}, integration)
	if err != nil {
		t.Fatal(err)
	}
	pending, _ := decodePending(res[0].PendingData)
	if pending.JobID != "job1" || res[0].Status != "pending" {
		t.Fatalf("unexpected pending %+v", res[0])
	}

	check, err := p.CheckPostStatus(ctx, "", res[0].PendingData, integration)
	if err != nil || check.Status != "ready" {
		t.Fatalf("check: %v %+v", err, check)
	}
	armed, err := p.FinalizePost(ctx, "", check.PendingData, integration)
	if err != nil || armed.Status != "pending" || len(f.records) != 0 {
		t.Fatalf("arm: %v %+v", err, armed)
	}
	witnessed, err := p.CheckPostStatus(ctx, "", armed.PendingData, integration)
	if err != nil || witnessed.Status != "ready" {
		t.Fatalf("witness: %v %+v", err, witnessed)
	}
	done, err := p.FinalizePost(ctx, "", witnessed.PendingData, integration)
	if err != nil || done.Status != "completed" {
		t.Fatalf("finalize: %v %+v", err, done)
	}
	embed, _ := json.Marshal(f.records[0]["record"].(map[string]any)["embed"])
	if !strings.Contains(string(embed), `"$type":"app.bsky.embed.video"`) || !strings.Contains(string(embed), "bafkvideo") {
		t.Fatalf("unexpected embed %s", embed)
	}

	// a witnessed attempt that never reported back must not run again
	_, err = p.CheckPostStatus(ctx, "", witnessed.PendingData, integration)
	if temporalx.FailureType(err) != temporalx.TypeBadBody {
		t.Fatalf("want bad_body, got %v", err)
	}
}

func TestErrorClassification(t *testing.T) {
	f := newFakePDS(t)
	p := newProvider(f.Client())
	ctx := context.Background()

	// a 4xx login is broken credentials: refresh-token flow
	_, err := p.getAgent(ctx, f.integration(t, "wrong"))
	if temporalx.FailureType(err) != temporalx.TypeRefreshToken {
		t.Fatalf("want refresh_token, got %v", err)
	}

	// a 4xx create (408 maps to 400) means nothing was published
	armed := PendingData{Message: "reject", Media: []PendingMedia{}, Attempting: true, Confirmed: true}
	_, err = p.FinalizePost(ctx, "", armed.raw(), f.integration(t, "app-password"))
	if temporalx.FailureType(err) != temporalx.TypeBadBody || temporalx.FailureMessage(err) != "Bluesky rejected the post, nothing was published, please check the content and try again" {
		t.Fatalf("want bad_body rejection, got %v", err)
	}
}

func TestCommentRepliesToThread(t *testing.T) {
	f := newFakePDS(t)
	res, err := newProvider(f.Client()).Comment(context.Background(), "did:plc:abcdefghijklmnopqrstuvwx", "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/root", "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/last", "", []integrations.PostDetails{{ID: "c", Message: "reply"}}, f.integration(t, "app-password"))
	if err != nil {
		t.Fatal(err)
	}
	if res[0].ReleaseURL != "https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/3kpost" {
		t.Fatalf("unexpected %+v", res[0])
	}
	reply, _ := json.Marshal(f.records[0]["record"].(map[string]any)["reply"])
	want := `{"parent":{"cid":"bafyparent","uri":"at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/last"},"root":{"cid":"bafyroot","uri":"at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/root"}}`
	if string(reply) != want {
		t.Fatalf("reply\n got %s\nwant %s", reply, want)
	}
}

func TestAutoRepostPlug(t *testing.T) {
	f := newFakePDS(t)
	p := newProvider(f.Client())
	plug := p.Plugs()[0]
	ok, err := plug.Run(context.Background(), f.integration(t, "app-password"), "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/x", map[string]string{"likesAmount": "3"})
	if err != nil || !ok {
		t.Fatalf("run: %v %v", ok, err)
	}
	if len(f.records) != 1 || f.records[0]["collection"] != "app.bsky.feed.repost" {
		t.Fatalf("want one repost, got %v", f.records)
	}
}

func TestImagesPreserveOriginalAndResizeToVerifiedLimit(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 100, 50))
	r := rand.New(rand.NewPCG(1, 2))
	for i := range img.Pix {
		img.Pix[i] = byte(r.UintN(256))
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/noise.png"
	if err := os.WriteFile(path, buf.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	media := []integrations.MediaContent{{Path: path, Type: "image"}}
	caps := socialidentity.BlueskyLexiconLimits()
	images, err := prepareImages(context.Background(), media, caps)
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 1 || images[0].width != 100 || images[0].height != 50 || !bytes.Equal(images[0].data, buf.Bytes()) {
		t.Fatal("selected image was changed")
	}
	limit := int64(2048)
	caps.BlobUploadLimit = &limit
	images, err = prepareImages(context.Background(), media, caps)
	if err != nil || len(images) != 1 {
		t.Fatalf("resize failed: %v", err)
	}
	if len(images[0].data) > 2048 || images[0].width >= 100 || images[0].height >= 50 {
		t.Fatal("verified blob limit was not applied")
	}
	original, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(original, buf.Bytes()) {
		t.Fatal("workspace original changed")
	}
	limit = 512
	if _, err := prepareImages(context.Background(), media, caps); temporalx.FailureType(err) != temporalx.TypeBadBody {
		t.Fatalf("unusable limit accepted: %v", err)
	}
}

// A delete removes the account's own record by its AT URI and refuses another account's.
func TestDeletePost(t *testing.T) {
	f := newFakePDS(t)
	var deleted []map[string]any
	f.override = func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.HasSuffix(r.URL.Path, "/xrpc/com.atproto.repo.deleteRecord") {
			return false
		}
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		deleted = append(deleted, in)
		_, _ = w.Write([]byte(`{}`))
		return true
	}
	p, ctx := newProvider(f.Client()), context.Background()
	if err := p.DeletePost(ctx, f.integration(t, "app-password"), "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/3kpost"); err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0]["repo"] != "did:plc:abcdefghijklmnopqrstuvwx" || deleted[0]["collection"] != "app.bsky.feed.post" || deleted[0]["rkey"] != "3kpost" {
		t.Fatalf("deleted %v", deleted)
	}
	if err := p.DeletePost(ctx, f.integration(t, "app-password"), "at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/app.bsky.feed.post/x"); err == nil || len(deleted) != 1 {
		t.Fatalf("another account's record = %v", err)
	}
}

package x

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var (
	_ integrations.Provider            = (*Provider)(nil)
	_ integrations.PendingPoster       = (*Provider)(nil)
	_ integrations.Commenter           = (*Provider)(nil)
	_ integrations.Analytics           = (*Provider)(nil)
	_ integrations.PostAnalytics       = (*Provider)(nil)
	_ integrations.MentionFormatter    = (*Provider)(nil)
	_ integrations.LinkStripper        = (*Provider)(nil)
	_ integrations.InlineImager        = (*Provider)(nil)
	_ interface{ Validate() []string } = (*XDto)(nil)
)

// Twitter's documented example ("Creating a signature").
func TestOAuthSignature(t *testing.T) {
	params := url.Values{
		"status":                 {"Hello Ladies + Gentlemen, a signed OAuth request!"},
		"include_entities":       {"true"},
		"oauth_consumer_key":     {"xvz1evFS4wEEPTGEFPHBog"},
		"oauth_nonce":            {"kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"},
		"oauth_signature_method": {"HMAC-SHA1"},
		"oauth_timestamp":        {"1318622958"},
		"oauth_token":            {"370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"},
		"oauth_version":          {"1.0"},
	}
	got := oauthSignature("post", "https://api.twitter.com/1.1/statuses/update.json", params,
		"kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE")
	if got != "hCtSmYh+iHYCEqBWrE7C7hYmtUk=" {
		t.Fatalf("signature = %s", got)
	}
}

func TestHandleErrors(t *testing.T) {
	cases := map[string]string{
		`{"detail":"You are not permitted to perform this action."}`: "bad-body",
		`{"title":"Too Many Requests"}`:                              "retry",
		`{"title":"Unauthorized","type":"about:blank"}`:              "refresh-token",
		`{"reason":"usage-capped"}`:                                  "bad-body",
	}
	for body, kind := range cases {
		if h := handleErrors(body, 400); h == nil || h.Type != kind {
			t.Errorf("%s => %+v, want %s", body, h, kind)
		}
	}
	if handleErrors(`{"ok":true}`, 400) != nil {
		t.Error("unexpected classification")
	}
}

func ptr(s string) *string { return &s }

func TestDtoValidate(t *testing.T) {
	d := &XDto{Community: ptr("https://x.com/i/communities/12"), WhoCanReplyPost: ptr("everyone")}
	if errs := d.Validate(); len(errs) != 0 {
		t.Fatalf("valid dto: %v", errs)
	}
	d = &XDto{Community: ptr("nope"), PostType: ptr("article"), MadeWithAI: "true"}
	want := []string{
		"Invalid X community URL. It should be in the format: https://x.com/i/communities/1493446837214187523",
		"Article title is required",
		"article_title must be a string",
		"article_status must be one of the following values: draft, published",
		"made_with_ai must be a boolean value",
	}
	if got := d.Validate(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %q", got)
	}
	if errs := (&XDto{}).Validate(); len(errs) != 1 || !strings.HasPrefix(errs[0], "who_can_reply_post must be one of") {
		t.Fatalf("missing who_can_reply_post: %v", errs)
	}
}

func TestMaxLengthAndValidity(t *testing.T) {
	p := New()
	if p.MaxLength([]integrations.AdditionalSetting{{Title: "Verified", Value: true}}, nil) != 280 ||
		p.MaxLength(nil, nil) != 280 || p.MaxLength(nil, json.RawMessage(`{"post_type":"article"}`)) != 100000 {
		t.Fatal("maxLength")
	}
	msg, _ := p.CheckValidity(context.Background(), [][]integrations.ValidityMedia{{{Path: "a.png"}}, {}}, json.RawMessage(`{"post_type":"article","article_status":"draft"}`), nil)
	if msg != "A draft article cannot have thread replies, remove them or publish the article" {
		t.Fatalf("validity = %q", msg)
	}
	msg, _ = p.CheckValidity(context.Background(), [][]integrations.ValidityMedia{{{Path: "a.mp4"}}}, json.RawMessage(`{"post_type":"article"}`), nil)
	if msg != "X articles only support images" {
		t.Fatalf("validity = %q", msg)
	}
}

func TestArticleContentState(t *testing.T) {
	state := articleContentState(`<h3>Title</h3><p>Hi <strong>bold</strong> <a href="https://a.b">link</a></p><img src="https://cdn/x.png"><ul><li>one</li></ul>`,
		[]string{"m1"}, map[string]string{"https://cdn/x.png": "inline"})
	got, _ := json.Marshal(state)
	want := `{"blocks":[{"key":"b0","text":"Title","type":"header-two"},` +
		`{"key":"b1","text":"Hi bold link","type":"unstyled","inline_style_ranges":[{"offset":3,"length":4,"style":"bold"}],"entity_ranges":[{"offset":8,"length":4,"key":0}]},` +
		`{"key":"b2","text":" ","type":"atomic","entity_ranges":[{"offset":0,"length":1,"key":1}]},` +
		`{"key":"b3","text":"one","type":"unordered-list-item"},` +
		`{"key":"b4","text":" ","type":"atomic","entity_ranges":[{"offset":0,"length":1,"key":2}]}],` +
		`"entities":[{"key":"0","value":{"type":"link","mutability":"mutable","data":{"url":"https://a.b"}}},` +
		`{"key":"1","value":{"type":"image","mutability":"immutable","data":{"media_items":[{"media_category":"tweet_image","media_id":"inline"}]}}},` +
		`{"key":"2","value":{"type":"image","mutability":"immutable","data":{"media_items":[{"media_category":"tweet_image","media_id":"m1"}]}}}]}`
	if string(got) != want {
		t.Fatalf("content state:\n%s", got)
	}
}

type recorded struct {
	method, path, auth, contentType string
	query                           url.Values
	body                            []byte
}

// fakeX records every request and answers with the handler's response.
func fakeX(t *testing.T, handler func(r recorded) (int, string)) (*[]recorded, func()) {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	t.Setenv("X_API_KEY", "key")
	t.Setenv("X_API_SECRET", "secret")
	var mu sync.Mutex
	var calls []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec := recorded{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.URL.Query(), body}
		mu.Lock()
		calls = append(calls, rec)
		mu.Unlock()
		status, out := handler(rec)
		if r.URL.Path == "/2/users/me" {
			w.Header().Set("x-access-level", "read-write")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, out)
	}))
	old := apiBase
	apiBase = srv.URL
	return &calls, func() { apiBase = old; srv.Close() }
}

func pngBytes() []byte {
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 20, 10)))
	return buf.Bytes()
}

func TestSignedImageUpload(t *testing.T) {
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/pic.png":
			return 200, string(pngBytes())
		case "/2/media/upload/initialize", "/2/media/upload/11/finalize":
			return 200, `{"data":{"id":"11"}}`
		case "/2/media/upload/11/append":
			return 200, `{}`
		}
		return 404, `{}`
	})
	defer done()
	signed := apiBase + "/pic.png?X-Amz-Date=20261013T000000Z&X-Amz-Signature=abc%2Fdef"
	res, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{
		ID: "p", Message: "image", Media: []integrations.MediaContent{{Path: signed}},
	}}, publishingAccount())
	if err != nil {
		t.Fatal(err)
	}
	if res[0].Status != "pending" {
		t.Fatalf("unexpected response: %+v", res[0])
	}
	var fetched, uploaded bool
	for _, call := range *calls {
		switch call.path {
		case "/pic.png":
			fetched = call.query.Get("X-Amz-Signature") == "abc/def"
		case "/2/media/upload/initialize":
			var body struct {
				MediaType string `json:"media_type"`
			}
			if err := json.Unmarshal(call.body, &body); err != nil {
				t.Fatal(err)
			}
			uploaded = body.MediaType == "image/png"
		}
	}
	if !fetched || !uploaded {
		t.Fatalf("signed image fetch=%t upload=%t", fetched, uploaded)
	}
}

func TestArticleFlow(t *testing.T) {
	var base string
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/pic.png":
			return 200, string(pngBytes())
		case "/2/media/upload/initialize":
			return 200, `{"data":{"id":"11"}}`
		case "/2/media/upload/11/append":
			return 200, ``
		case "/2/media/upload/11/finalize":
			return 200, `{"data":{"id":"11"}}`
		case "/2/articles/draft":
			return 200, `{"data":{"id":"91"}}`
		case "/2/articles/91/publish":
			return 200, `{"data":{"post_id":"555"}}`
		}
		return 404, `{}`
	})
	defer done()
	base = apiBase
	p := New()
	ctx := context.Background()
	integration := publishingAccount()

	settings := json.RawMessage(`{"post_type":"article","article_title":"T","article_status":"published"}`)
	res, err := p.Post(ctx, "1", "a:b", []integrations.PostDetails{{
		ID: "p1", Message: `<p>Hello</p><img src="` + base + `/pic.png">`, Settings: settings,
	}}, integration)
	if err != nil {
		t.Fatal(err)
	}
	if res[0].PostID != "555" || res[0].ReleaseURL != "https://twitter.com/me/status/555" || res[0].Status != "posted" {
		t.Fatalf("response %+v", res[0])
	}
	var draft recorded
	for _, c := range *calls {
		if c.path == "/2/articles/draft" {
			draft = c
		}
		if strings.HasPrefix(c.path, "/2/") && !strings.HasPrefix(c.auth, `OAuth oauth_consumer_key="key"`) {
			t.Fatalf("unsigned call %s: %q", c.path, c.auth)
		}
	}
	var body struct {
		Title        string       `json:"title"`
		ContentState contentState `json:"content_state"`
	}
	if err := json.Unmarshal(draft.body, &body); err != nil {
		t.Fatal(err)
	}
	if body.Title != "T" || len(body.ContentState.Blocks) != 2 || body.ContentState.Blocks[1].Type != "atomic" {
		t.Fatalf("draft body %s", draft.body)
	}
}

func TestFinalizeTweet(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		return 201, `{"data":{"id":"99"}}`
	})
	defer done()
	pending := marshal(pendingData{
		Message:  "hi",
		Settings: pendingSettings{WhoCanReplyPost: ptr("following"), Community: ptr("https://x.com/i/communities/42"), MadeWithAI: "true"},
		MediaIDs: []string{"11"}, MediaFacts: []mediaFacts{{MIME: "image/png", Bytes: 100}}, Attempting: true, Confirmed: true,
	})
	res, err := New().FinalizePost(context.Background(), "a:b", pending, publishingAccount())
	if err != nil {
		t.Fatal(err)
	}
	if res.PostID != "99" || res.ReleaseURL != "https://twitter.com/me/status/99" {
		t.Fatalf("%+v", res)
	}
	want := `{"reply_settings":"following","share_with_followers":true,"community_id":"42","text":"hi","media":{"media_ids":["11"]},"made_with_ai":true,"paid_partnership":false}`
	if got := string((*calls)[1].body); got != want {
		t.Fatalf("tweet body %s", got)
	}
}

func TestFinalizeTweetError(t *testing.T) {
	_, done := fakePublishingX(t, func(r recorded) (int, string) {
		return 403, `{"detail":"You are not permitted to perform this action.","status":403}`
	})
	defer done()
	pending := marshal(pendingData{Message: "hi", Attempting: true, Confirmed: true})
	_, err := New().FinalizePost(context.Background(), "a:b", pending, publishingAccount())
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected ||
		temporalx.FailureMessage(err) != "There is a problem posting, please edit your post and check character count and media attachments" {
		t.Fatalf("err = %v", err)
	}
}

func TestHandshakeAndProcessing(t *testing.T) {
	state := "in_progress"
	status := 200
	_, done := fakeX(t, func(r recorded) (int, string) {
		if status != 200 {
			return status, `{"title":"Unauthorized","status":401}`
		}
		return 200, `{"data":{"processing_info":{"state":"` + state + `"}}}`
	})
	defer done()
	p := New()
	ctx := context.Background()
	pending := marshal(pendingData{Message: "m", MediaIDs: []string{"v"}, ProcessingIDs: []string{"v"}})

	check, err := p.CheckPostStatus(ctx, "a:b", pending, nil)
	if err != nil || check.Status != "pending" {
		t.Fatalf("processing: %+v %v", check, err)
	}
	state = "succeeded"
	check, _ = p.CheckPostStatus(ctx, "a:b", check.PendingData, nil)
	if check.Status != "ready" {
		t.Fatalf("ready: %+v", check)
	}
	armed, _ := p.FinalizePost(ctx, "a:b", check.PendingData, nil)
	if armed.Status != "pending" || !strings.Contains(string(armed.PendingData), `"attempting":true`) {
		t.Fatalf("armed: %s", armed.PendingData)
	}
	confirmed, _ := p.CheckPostStatus(ctx, "a:b", armed.PendingData, nil)
	if !strings.Contains(string(confirmed.PendingData), `"confirmed":true`) {
		t.Fatalf("confirmed: %s", confirmed.PendingData)
	}
	if _, err := p.CheckPostStatus(ctx, "a:b", confirmed.PendingData, nil); temporalx.FailureType(err) != temporalx.TypeUnknownDelivery {
		t.Fatalf("died attempt: %v", err)
	}

	status = 401
	_, err = p.CheckPostStatus(ctx, "a:b", pending, nil)
	if temporalx.FailureType(err) != temporalx.TypeRefreshToken {
		t.Fatalf("401: %v", err)
	}
}

func TestVideoChunkUpload(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch {
		case strings.HasSuffix(r.path, "/initialize"):
			return 200, `{"data":{"id":"22"}}`
		case strings.HasSuffix(r.path, "/finalize"):
			return 200, `{"data":{"id":"22","processing_info":{"state":"pending","check_after_secs":1}}}`
		}
		return 200, `{}`
	})
	defer done()
	file := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(file, videoFixture(t, uploadChunkSize+10), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{
		ID: "p", Message: "m",
		Media: []integrations.MediaContent{{Type: "video", Path: file}},
	}}, publishingAccount())
	if err != nil {
		t.Fatal(err)
	}
	var pending pendingData
	_ = json.Unmarshal(res[0].PendingData, &pending)
	if res[0].Status != "pending" || strings.Join(pending.ProcessingIDs, ",") != "22" || strings.Join(pending.MediaIDs, ",") != "22" {
		t.Fatalf("pending %s", res[0].PendingData)
	}
	appends := 0
	for _, c := range *calls {
		if strings.HasSuffix(c.path, "/append") {
			appends++
			if !strings.HasPrefix(c.contentType, "multipart/form-data") {
				t.Fatalf("append content type %s", c.contentType)
			}
		}
		if strings.HasSuffix(c.path, "/initialize") && !strings.Contains(string(c.body), `"total_bytes":1048586`) {
			t.Fatalf("init body %s", c.body)
		}
	}
	if appends != 2 {
		t.Fatalf("appends = %d", appends)
	}
}

func TestUploadErrorClassified(t *testing.T) {
	_, done := fakePublishingX(t, func(r recorded) (int, string) {
		return 400, `{"detail":"Your media IDs are invalid."}`
	})
	defer done()
	file := filepath.Join(t.TempDir(), "clip.mp4")
	_ = os.WriteFile(file, videoFixture(t, 0), 0o600)
	_, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{
		ID: "p", Media: []integrations.MediaContent{{Path: file}},
	}}, publishingAccount())
	if temporalx.FailureMessage(err) != "X rejected the attached media, please re-upload the media and try again" {
		t.Fatalf("err = %v", err)
	}
}

func TestAuthFlow(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://app")
	calls, done := fakeX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/oauth/request_token":
			return 200, "oauth_token=rt&oauth_token_secret=rs&oauth_callback_confirmed=true"
		case "/oauth/access_token":
			return 200, "oauth_token=at&oauth_token_secret=as&user_id=1&screen_name=me"
		case "/2/users/me":
			return 200, `{"data":{"id":"1","name":"Me","username":"me","verified":true,"profile_image_url":"pic"}}`
		}
		return 404, "{}"
	})
	defer done()
	p := New()
	ctx := context.Background()
	link, err := p.GenerateAuthURL(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if link.URL != apiBase+"/oauth/authenticate?oauth_token=rt&force_login=false" || link.CodeVerifier != "rt:rs" || link.State != "rt" {
		t.Fatalf("%+v", link)
	}
	if string((*calls)[0].body) != "oauth_callback=https%3A%2F%2Fapp%2Fintegrations%2Fsocial%2Fx&x_auth_access_type=write" {
		t.Fatalf("request_token body %s", (*calls)[0].body)
	}
	auth, err := p.Authenticate(ctx, integrations.AuthenticateParams{Code: "verifier", CodeVerifier: link.CodeVerifier}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if auth.AccessToken != "at:as" || auth.Username != "me" || len(auth.AdditionalSettings) != 0 || !auth.NonExpiring || auth.ExpiresIn != 0 ||
		auth.Verification == nil || auth.Verification.Validate("x", "1") != nil {
		t.Fatalf("%+v", auth)
	}
	if !strings.Contains((*calls)[1].auth, `oauth_token="rt"`) || !strings.Contains((*calls)[2].auth, `oauth_token="at"`) {
		t.Fatal("tokens not used for signing")
	}
}

func TestAPIErrorJSON(t *testing.T) {
	e := &apiResponseError{Type: "response", Code: 429, Err: true, Headers: map[string]string{}, Data: map[string]any{"title": "Too Many Requests"}}
	text, _ := json.Marshal(e)
	if !strings.HasPrefix(string(text), `{"type":"response","code":429,"error":true`) || handleErrors(string(text), 200).Type != "retry" || !e.rateLimitError() {
		t.Fatalf("%s", text)
	}
}

// RFC 025 follow-ups: engagement reads public metrics (no 100-user cap), a
// repost is removed by DELETE, and a plug reply returns its id.
func TestFollowUps(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch {
		case r.method == "GET" && r.path == "/2/tweets/42":
			return 200, `{"data":{"id":"42","public_metrics":{"like_count":250,"retweet_count":12}}}`
		case r.method == "POST" && r.path == "/2/users/1/retweets":
			return 200, `{"data":{"retweeted":true}}`
		case r.method == "DELETE" && r.path == "/2/users/1/retweets/42":
			return 200, `{"data":{"retweeted":false}}`
		case r.method == "POST" && r.path == "/2/tweets":
			return 201, `{"data":{"id":"99"}}`
		}
		return 404, `{}`
	})
	defer done()
	ctx := context.Background()
	account := publishingAccount()
	provider := New()
	likes, reposts, err := provider.PostEngagement(ctx, account, "42")
	if err != nil || likes != 250 || reposts != 12 {
		t.Fatalf("engagement = %d, %d, %v", likes, reposts, err)
	}
	if (*calls)[0].query.Get("tweet.fields") != "public_metrics" {
		t.Fatalf("query = %v", (*calls)[0].query)
	}
	if err := provider.RetweetPost(ctx, account, "42"); err != nil {
		t.Fatal(err)
	}
	if err := provider.UnretweetPost(ctx, account, "42"); err != nil {
		t.Fatal(err)
	}
	id, err := provider.ReplyTo(ctx, account, "42", "Get the guide")
	if err != nil || id != "99" {
		t.Fatalf("reply = %q, %v", id, err)
	}
	var reply struct {
		Reply struct {
			InReplyTo string `json:"in_reply_to_tweet_id"`
		} `json:"reply"`
	}
	if err := json.Unmarshal((*calls)[4].body, &reply); err != nil || reply.Reply.InReplyTo != "42" {
		t.Fatalf("reply body = %s", (*calls)[4].body)
	}
	if done, err := provider.AutoRepostPost(ctx, account, "42", map[string]string{"likesAmount": "200"}); err != nil || !done {
		t.Fatalf("like-gated repost past 100 likes = %v, %v", done, err)
	}
}

// A delete removes a post by DELETE; a post that is already gone reports 404.
func TestDeletePost(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		if r.method == "DELETE" && r.path == "/2/tweets/42" {
			return 200, `{"data":{"deleted":true}}`
		}
		return 404, `{"title":"Not Found Error"}`
	})
	defer done()
	provider, account := New(), publishingAccount()
	if err := provider.DeletePost(context.Background(), account, "42"); err != nil || len(*calls) != 1 {
		t.Fatalf("delete = %v, calls %d", err, len(*calls))
	}
	var status interface{ HTTPStatus() int }
	if err := provider.DeletePost(context.Background(), account, "43"); !errors.As(err, &status) || status.HTTPStatus() != 404 {
		t.Fatalf("missing post = %v", err)
	}
}

// An image's description is set on the media before the post that uses it.
func TestAltTextGoesOnTheMedia(t *testing.T) {
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/pic.png":
			return 200, string(pngBytes())
		case "/2/media/upload/initialize", "/2/media/upload/11/finalize":
			return 200, `{"data":{"id":"11"}}`
		case "/2/media/upload/11/append", "/2/media/metadata":
			return 200, `{}`
		}
		return 404, `{}`
	})
	defer done()
	if _, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{
		ID: "p", Message: "image", Media: []integrations.MediaContent{{Path: apiBase + "/pic.png", Alt: "A chart of signups"}},
	}}, publishingAccount()); err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		ID       string `json:"id"`
		Metadata struct {
			AltText struct {
				Text string `json:"text"`
			} `json:"alt_text"`
		} `json:"metadata"`
	}
	found := false
	for _, call := range *calls {
		if call.path == "/2/media/metadata" {
			found = json.Unmarshal(call.body, &metadata) == nil
		}
	}
	if !found || metadata.ID != "11" || metadata.Metadata.AltText.Text != "A chart of signups" {
		t.Fatalf("metadata = %+v (found %v)", metadata, found)
	}
}

func TestArticlePreservesStylesEmptyParagraphsAndEmbeddedPosts(t *testing.T) {
	state := articleContentState(`<p><strong>😀</strong><em>italic</em><s>strike</s><br>next</p><p></p><blockquote data-x-post="123"><a href="https://x.com/i/status/123">post</a></blockquote>`, nil, nil)
	if len(state.Blocks) != 3 || state.Blocks[0].Text != "😀italicstrike\nnext" || state.Blocks[1].Text != "" || state.Blocks[2].Type != "atomic" {
		t.Fatalf("blocks: %+v", state.Blocks)
	}
	styles := state.Blocks[0].InlineStyleRanges
	if len(styles) != 3 || styles[0].Length != 2 || styles[1].Offset != 2 || styles[1].Style != "italic" || styles[2].Style != "strikethrough" {
		t.Fatalf("styles: %+v", styles)
	}
	if len(state.Entities) != 1 || state.Entities[0].Value.Type != "post" || state.Entities[0].Value.Data.(map[string]string)["post_id"] != "123" {
		t.Fatalf("entities: %+v", state.Entities)
	}
}

func TestCommunityBroadcastKeepsExplicitFalse(t *testing.T) {
	for _, share := range []bool{false, true} {
		t.Run(fmt.Sprint(share), func(t *testing.T) {
			calls, done := fakePublishingX(t, func(r recorded) (int, string) { return 201, `{"data":{"id":"99"}}` })
			defer done()
			pending := marshal(pendingData{Message: "community", Settings: pendingSettings{WhoCanReplyPost: ptr("everyone"), Community: ptr("https://x.com/i/communities/42"), ShareWithFollowers: &share}, Attempting: true, Confirmed: true})
			if _, err := New().FinalizePost(context.Background(), "a:b", pending, publishingAccount()); err != nil {
				t.Fatal(err)
			}
			var body map[string]any
			if err := json.Unmarshal((*calls)[1].body, &body); err != nil {
				t.Fatal(err)
			}
			if body["share_with_followers"] != share || body["community_id"] != "42" {
				t.Fatalf("broadcast intent lost: %v", body)
			}
		})
	}
}

// A 429 keeps X's reset, so a delete waits for it instead of spending retries.
func TestAPIErrorCarriesTheRateLimitReset(t *testing.T) {
	header := http.Header{"X-Rate-Limit-Limit": {"50"}, "X-Rate-Limit-Reset": {"1794585600"}}
	e := newAPIError(&http.Response{StatusCode: http.StatusTooManyRequests, Header: header}, nil)
	if e.HTTPStatus() != http.StatusTooManyRequests || !e.RetryAt().Equal(time.Unix(1794585600, 0)) {
		t.Fatalf("status %d reset %v", e.HTTPStatus(), e.RetryAt())
	}
}

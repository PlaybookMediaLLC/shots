package facebook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func setup(t *testing.T, mux *http.ServeMux) *Provider {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	old := graphURL
	graphURL = srv.URL
	t.Cleanup(func() { graphURL = old })
	p := New()
	p.RetryDelay = 0
	return p
}

func TestHandleErrors(t *testing.T) {
	cases := []struct {
		body, kind, value string
		status            int
	}{
		{`{"error":{"message":"Error validating access token"}}`, "refresh-token", "Please re-authenticate your Facebook account", 400},
		{`{"error":{"code":368,"error_subcode":1390008}}`, "retry", "You are posting too fast, please slow down", 400},
		{`{"error":{"error_subcode":459}}`, "bad-body", "Facebook is asking you to resolve a security check. Log in at facebook.com, complete it, then try again", 400},
		{`{"error":{"error_subcode":33,"message":"Object does not exist"}}`, "bad-body", "The Facebook Page or post this was targeting no longer exists, please reconnect the channel and schedule again", 400},
		{`{}`, "bad-body", "An unknown error occurred, please try again later or contact support", 401},
	}
	for _, c := range cases {
		got := HandleErrors(c.body, c.status)
		if got == nil || got.Type != c.kind || got.Value != c.value {
			t.Errorf("HandleErrors(%s) = %+v", c.body, got)
		}
	}
	if HandleErrors(`{"error_subcode":4590}`, 400) != nil {
		t.Error("subcode 4590 must not match 459")
	}
}

func TestStoryPendingFlow(t *testing.T) {
	var published []string
	videoChecks := 0
	mux := http.NewServeMux()
	var uploadURL string
	mux.HandleFunc("POST /v25.0/page1/video_stories", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("upload_phase") == "start" {
			json.NewEncoder(w).Encode(map[string]string{"video_id": "v1", "upload_url": uploadURL})
			return
		}
		published = append(published, "video:"+r.URL.Query().Get("video_id"))
		w.Write([]byte(`{"post_id":"s1"}`))
	})
	mux.HandleFunc("POST /upload", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "OAuth tok" || r.Header.Get("file_url") != "https://cdn/v.mp4" {
			t.Errorf("upload headers: %v", r.Header)
		}
		w.Write([]byte(`{}`))
	})
	mux.HandleFunc("POST /v25.0/page1/photos", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"url":"https://cdn/p.jpg","published":false}` {
			t.Errorf("photo body %s", body)
		}
		w.Write([]byte(`{"id":"p1"}`))
	})
	mux.HandleFunc("GET /v25.0/v1", func(w http.ResponseWriter, r *http.Request) {
		videoChecks++
		if videoChecks == 1 {
			w.Write([]byte(`{"status":{"video_status":"processing"}}`))
			return
		}
		w.Write([]byte(`{"status":{"video_status":"ready"}}`))
	})
	mux.HandleFunc("POST /v25.0/page1/photo_stories", func(w http.ResponseWriter, r *http.Request) {
		published = append(published, "photo:"+r.URL.Query().Get("photo_id"))
		w.Write([]byte(`{"post_id":"s2"}`))
	})
	p := setup(t, mux)
	uploadURL = graphURL + "/upload"
	ctx := context.Background()
	integration := &ent.Integration{InternalID: "page1"}

	res, err := p.PostPending(ctx, "page1", "tok", []integrations.PostDetails{{
		ID: "post", Settings: json.RawMessage(`{"post_type":"story"}`),
		Media: []integrations.MediaContent{{Path: "https://cdn/v.mp4"}, {Path: "https://cdn/p.jpg"}},
	}}, integration)
	if err != nil || res[0].Status != "pending" {
		t.Fatalf("postPending: %v %+v", err, res)
	}

	data := res[0].PendingData
	var steps []string
	for i := 0; i < 20; i++ {
		check, err := p.CheckPostStatus(ctx, "tok", data, integration)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, "check:"+check.Status)
		if check.Status == "pending" {
			data = check.PendingData
			continue
		}
		result, err := p.FinalizePost(ctx, "tok", check.PendingData, integration)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, "finalize:"+result.Status)
		if result.Status == "completed" {
			if result.PostID != "s2" || result.ReleaseURL != "https://www.facebook.com/stories/s2" {
				t.Fatalf("completed %+v", result)
			}
			break
		}
		data = result.PendingData
	}
	want := "check:pending check:ready finalize:pending check:ready finalize:pending check:ready finalize:pending check:ready finalize:completed"
	if got := strings.Join(steps, " "); got != want {
		t.Fatalf("steps\n got %s\nwant %s", got, want)
	}
	if strings.Join(published, ",") != "video:v1,photo:p1" {
		t.Fatalf("published %v", published)
	}

	// an armed and confirmed attempt that comes back means the run died
	// mid-publish: never publish again
	_, err = p.CheckPostStatus(ctx, "tok", json.RawMessage(`{"postType":"story","items":[{"kind":"photo","mediaId":"p1"}],"publishedCount":0,"lastPostId":"","attempting":0,"confirmed":true}`), integration)
	if temporalx.FailureType(err) != temporalx.TypeBadBody || !strings.Contains(temporalx.FailureMessage(err), "may have already published") {
		t.Fatalf("expected duplicate guard, got %v", err)
	}
}

func TestFeedPresetFallback(t *testing.T) {
	var bodies []string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/page1/feed", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(body))
		if strings.Contains(string(body), "text_format_preset_id") {
			w.WriteHeader(400)
			w.Write([]byte(`{"error":{"message":"Invalid parameter text_format_preset_id","code":100}}`))
			return
		}
		w.Write([]byte(`{"id":"page1_9","permalink_url":"https://fb/9"}`))
	})
	p := setup(t, mux)
	res, err := p.Post(context.Background(), "page1", "tok", []integrations.PostDetails{{
		ID: "post", Message: "hello", Settings: json.RawMessage(`{"text_format_preset_id":"106018623298955","url":"https://x.com"}`),
	}}, &ent.Integration{})
	if err != nil {
		t.Fatal(err)
	}
	if res[0].PostID != "page1_9" || res[0].ReleaseURL != "https://fb/9" || res[0].Status != "success" {
		t.Fatalf("%+v", res)
	}
	want := []string{
		`{"link":"https://x.com","text_format_preset_id":"106018623298955","message":"hello","published":true}`,
		`{"link":"https://x.com","message":"hello","published":true}`,
	}
	if strings.Join(bodies, "\n") != strings.Join(want, "\n") {
		t.Fatalf("bodies\n%s", strings.Join(bodies, "\n"))
	}
}

func TestFeedPermissionError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/page1/feed", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`{"error":{"message":"(#200) Permissions error","code":200}}`))
	})
	p := setup(t, mux)
	_, err := p.Post(context.Background(), "page1", "tok", []integrations.PostDetails{{ID: "post", Message: "hi"}}, &ent.Integration{})
	if temporalx.FailureType(err) != temporalx.TypeBadBody || !strings.HasPrefix(temporalx.FailureMessage(err), "Facebook rejected the post due to missing permissions") {
		t.Fatalf("got %v", err)
	}
}

// Facebook calls "Sorry, something went wrong" retryable, but after a publish
// it may have posted: one request, outcome unknown, no resend without the preset.
func TestFeedServerErrorIsNotResent(t *testing.T) {
	requests := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/page1/feed", func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(500)
		w.Write([]byte(`{"error":{"message":"Sorry, something went wrong.","code":1}}`))
	})
	p := setup(t, mux)
	_, err := p.Post(context.Background(), "page1", "tok", []integrations.PostDetails{{
		ID: "post", Message: "hello", Settings: json.RawMessage(`{"text_format_preset_id":"106018623298955"}`),
	}}, &ent.Integration{})
	if requests != 1 || temporalx.FailureType(err) != temporalx.TypeUnknownDelivery {
		t.Fatalf("requests=%d err=%v", requests, err)
	}
}

func TestFetchPageInformation(t *testing.T) {
	mux := http.NewServeMux()
	var base string
	mux.HandleFunc("GET /v25.0/me/accounts", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"1","name":"Other"}]}`))
	})
	mux.HandleFunc("GET /v25.0/me/businesses", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"b1"}]}`))
	})
	mux.HandleFunc("GET /v25.0/b1/owned_pages", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("after") == "" {
			// listed without a token first, then with one on the next page
			json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "2", "name": "Mine"}}, "paging": map[string]any{"next": base + "/v25.0/b1/owned_pages?after=x"}})
			return
		}
		w.Write([]byte(`{"data":[]}`))
	})
	mux.HandleFunc("GET /v25.0/b1/client_pages", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"data":[{"id":"2","name":"Mine","access_token":"pt","username":"mine","picture":{"data":{"url":"https://pic"}}}]}`))
	})
	p := setup(t, mux)
	base = graphURL
	info, err := p.FetchPageInformation(context.Background(), "tok", json.RawMessage(`{"page":"2"}`))
	if err != nil {
		t.Fatal(err)
	}
	if *info != (integrations.FetchPageInformationResult{ID: "2", Name: "Mine", AccessToken: "pt", Picture: "https://pic", Username: "mine"}) {
		t.Fatalf("%+v", info)
	}
	if _, err := p.FetchPageInformation(context.Background(), "tok", json.RawMessage(`{"page":"3"}`)); err == nil || err.Error() != "Page not found in your accounts" {
		t.Fatalf("got %v", err)
	}
}

func TestFacebookDTOValidate(t *testing.T) {
	story, bad := "story", "reel"
	if msgs := (&FacebookDTO{URL: "https://example.com/a?b=c", PostType: &story}).Validate(); len(msgs) != 0 {
		t.Fatalf("valid dto: %v", msgs)
	}
	msgs := (&FacebookDTO{URL: "not a url", PostType: &bad}).Validate()
	if strings.Join(msgs, "|") != "url must be a URL address|post_type must be one of the following values: post, story" {
		t.Fatalf("%v", msgs)
	}
	for u, want := range map[string]bool{
		"example.com": true, "http://localhost": false, "ftp://a.io:21/x": true, "mailto:a@b.co": false,
		"https://a_b.com": false, "http://1.2.3.4": true, "https://user:pw@site.org": true, "//site.org": false,
	} {
		if isURL(u) != want {
			t.Errorf("isURL(%q) != %v", u, want)
		}
	}
}

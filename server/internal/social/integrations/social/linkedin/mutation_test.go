package linkedin

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func TestMutationsDoNotRetryAmbiguousResponses(t *testing.T) {
	for _, action := range []string{"post", "comment", "repost"} {
		for _, status := range []int{201, 408, 500, 503, 403, 429} {
			t.Run(action+http.StatusText(status), func(t *testing.T) {
				endpoint := "/rest/posts"
				if action == "comment" {
					endpoint = "/rest/socialActions/urn:li:share:42/comments"
				}
				f, _ := newFake(t, map[string]http.HandlerFunc{"POST " + endpoint: func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("Retry-After", "60")
					w.WriteHeader(status)
					_, _ = w.Write([]byte(`{}`))
				}})
				var err error
				switch action {
				case "post":
					_, err = New().createMainPost(context.Background(), &pendingData{AuthorID: "1", PostType: Personal, Message: "Hello"}, "tok")
				case "comment":
					_, err = New().createCommentPost(context.Background(), "1", "tok", integrations.PostDetails{Message: "Hello"}, "urn:li:share:42", Personal)
				case "repost":
					err = New().Repost(context.Background(), "tok", "urn:li:person:1", "urn:li:share:42")
				}
				want := temporalx.TypeUnknownDelivery
				if status == 403 {
					want = temporalx.TypeBadBody
				}
				// A 429 created nothing: the workflow retries it durably, after LinkedIn's guidance.
				if status == 429 {
					want = temporalx.TypeRateLimited
					if after := temporalx.RetryAfter(err); after < 50*time.Second || after > time.Minute {
						t.Fatalf("retry after = %v", after)
					}
				}
				if temporalx.FailureType(err) != want || len(f.find("POST", endpoint)) != 1 {
					t.Fatalf("error=%v requests=%d", err, len(f.find("POST", endpoint)))
				}
			})
		}
	}
}

func TestNativeCommentReceiptAndLiteralText(t *testing.T) {
	const parent = "urn:li:share:42"
	const native = "urn:li:comment:(urn:li:activity:44,55)"
	for _, body := range []string{`{"object":"urn:li:activity:44","id":"55"}`, `{"commentUrn":"` + native + `"}`} {
		f, _ := newFake(t, map[string]http.HandlerFunc{"POST /rest/socialActions/" + parent + "/comments": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("x-restli-id", "55")
			w.WriteHeader(201)
			_, _ = w.Write([]byte(body))
		}})
		text := "Guide (2026) #launch https://example.com/a_b?x=1&y=2"
		posted, err := New().CommentAs(context.Background(), "123", parent, "tok", []integrations.PostDetails{{ID: "comment", Message: text}}, Company)
		if err != nil || len(posted) != 1 || posted[0].PostID != native {
			t.Fatalf("posted=%+v err=%v", posted, err)
		}
		c := f.find("POST", "/rest/socialActions/"+parent+"/comments")[0]
		var payload struct {
			Actor, Object string
			Message       struct{ Text string }
		}
		if json.Unmarshal(c.body, &payload) != nil || payload.Message.Text != text || payload.Actor != "urn:li:organization:123" || payload.Object != parent {
			t.Fatalf("payload=%s", c.body)
		}
		if c.header.Get("LinkedIn-Version") != Headers("", "")["LinkedIn-Version"] {
			t.Fatal("retired comment API")
		}
	}
}

func TestNativeMentionNamesAndIdentities(t *testing.T) {
	text := `Thanks @[Anne \(AJ\) Doe](urn:li:person:abc_123) and @[Acme \[Labs\]](urn:li:organization:42)!`
	if got := FixText(text); got != text {
		t.Fatalf("lost native mention: %q", got)
	}
	invalid := `@[Invented](urn:li:person:wrong/id)`
	if got := FixText(invalid); strings.Contains(got, invalid) {
		t.Fatalf("invalid native annotation: %q", got)
	}
	f, _ := newFake(t, map[string]http.HandlerFunc{"POST /rest/posts": func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-restli-id", "urn:li:share:9")
		w.WriteHeader(201)
	}})
	_, err := New().createMainPost(context.Background(), &pendingData{AuthorID: "123", PostType: Company, Message: text}, "tok")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal(f.find("POST", "/rest/posts")[0].body, &payload)
	if payload["commentary"] != text {
		t.Fatalf("payload=%+v", payload)
	}
}

func TestMutationRedirectAndOversizedReceiptRemainUnknown(t *testing.T) {
	for _, redirect := range []bool{false, true} {
		f, server := newFake(t, nil)
		f.routes["POST /rest/posts"] = func(w http.ResponseWriter, r *http.Request) {
			if redirect {
				http.Redirect(w, r, server.URL+"/redirected", http.StatusTemporaryRedirect)
				return
			}
			w.Header().Set("x-restli-id", "urn:li:share:42")
			_, _ = w.Write([]byte(strings.Repeat("x", (1<<20)+1)))
		}
		_, err := New().createMainPost(context.Background(), &pendingData{AuthorID: "1", PostType: Personal, Message: "Hello"}, "tok")
		if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || len(f.calls) != 1 {
			t.Fatalf("redirect=%t calls=%d err=%v", redirect, len(f.calls), err)
		}
	}
}

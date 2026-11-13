package x

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func TestContentMutationsSendOnlyOnce(t *testing.T) {
	for _, action := range []string{"root", "comment", "direct reply", "article draft", "article publish"} {
		for _, response := range []struct {
			name, body, kind string
			status           int
		}{
			{"server error", `{"detail":"Service Unavailable"}`, temporalx.TypeUnknownDelivery, 503},
			{"internal error", `{}`, temporalx.TypeUnknownDelivery, 500},
			{"rate limit", `{"detail":"Too Many Requests"}`, temporalx.TypeRateLimited, 429},
			{"unauthorized", `{}`, temporalx.TypeRefreshToken, 401},
			{"rejected", `{}`, temporalx.TypePublicationRejected, 400},
			{"missing receipt", `{"data":{}}`, temporalx.TypeUnknownDelivery, 201},
			{"malformed receipt", `{"data":`, temporalx.TypeUnknownDelivery, 201},
			{"partial error", `{"data":{"id":"91","post_id":"92"},"errors":[{"message":"private canary"}]}`, temporalx.TypeUnknownDelivery, 201},
			{"unsafe ID", `{"data":{"id":"../other","post_id":"../other"}}`, temporalx.TypeUnknownDelivery, 201},
		} {
			t.Run(action+"/"+response.name, func(t *testing.T) {
				calls, done := fakePublishingX(t, func(r recorded) (int, string) { return response.status, response.body })
				defer done()
				p := New()
				p.RetryDelay = time.Millisecond
				in := publishingAccount()
				ctx := context.Background()
				var err error
				pending := pendingData{Message: "hello", Attempting: true, Confirmed: true}
				switch action {
				case "comment":
					_, err = p.Comment(ctx, "1", "42", "", in.Token, []integrations.PostDetails{{ID: "p", Message: "hello"}}, in)
				case "direct reply":
					_, err = p.ReplyTo(ctx, in, "42", "hello")
				default:
					if strings.HasPrefix(action, "article") {
						pending.Settings = pendingSettings{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("published")}
						if action == "article publish" {
							pending.ArticleDraftID = "91"
						}
					}
					_, err = p.FinalizePost(ctx, in.Token, marshal(pending), in)
				}
				want := response.kind
				if action == "article publish" && response.name == "rate limit" {
					// Its draft is saved on X, so a whole-post retry would make another.
					want = temporalx.TypeUnknownDelivery
				}
				if temporalx.FailureType(err) != want || len(*calls) != 2 {
					t.Fatalf("classification=%v, requests=%d", err, len(*calls))
				}
				if strings.Contains(err.Error(), "private canary") {
					t.Fatal("provider response leaked")
				}
			})
		}
	}
}

// A 429 created nothing: it carries X's reset time for the durable retry, and a
// spent 24-hour allowance is a daily limit rather than a retry.
func TestRateLimitedMutationCarriesRetryGuidance(t *testing.T) {
	reset := strconv.FormatInt(time.Now().Add(10*time.Minute).Unix(), 10)
	for _, tc := range []struct {
		name, kind string
		headers    map[string]string
	}{
		{"rate limit", temporalx.TypeRateLimited, map[string]string{"x-rate-limit-reset": reset}},
		{"daily cap", temporalx.TypeDailyLimit, map[string]string{"x-rate-limit-reset": reset, "x-user-limit-24hour-remaining": "0"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DISABLE_SSRF_PROTECTION", "true")
			t.Setenv("X_API_KEY", "key")
			t.Setenv("X_API_SECRET", "secret")
			var mutations atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/2/users/me" {
					w.Header().Set("x-access-level", "read-write")
					_, _ = io.WriteString(w, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"Premium"}}`)
					return
				}
				mutations.Add(1)
				for key, value := range tc.headers {
					w.Header().Set(key, value)
				}
				w.WriteHeader(http.StatusTooManyRequests)
			}))
			old := apiBase
			apiBase = server.URL
			defer func() { apiBase = old; server.Close() }()
			_, err := New().ReplyTo(context.Background(), publishingAccount(), "42", "hello")
			if temporalx.FailureType(err) != tc.kind || mutations.Load() != 1 {
				t.Fatalf("classification=%v, mutations=%d", err, mutations.Load())
			}
			if tc.kind == temporalx.TypeRateLimited && temporalx.RetryAfter(err) < 9*time.Minute {
				t.Fatalf("retry guidance lost: %v", temporalx.RetryAfter(err))
			}
		})
	}
}

func TestMutationRedirectDisconnectAndOversizeAreUncertain(t *testing.T) {
	for _, mode := range []string{"redirect", "disconnect", "oversize"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("DISABLE_SSRF_PROTECTION", "true")
			t.Setenv("X_API_KEY", "fixture-key")
			t.Setenv("X_API_SECRET", "fixture-secret")
			var received atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received.Add(1)
				switch mode {
				case "redirect":
					http.Redirect(w, r, "/again", http.StatusTemporaryRedirect)
				case "disconnect":
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = connection.Close()
				case "oversize":
					_, _ = w.Write([]byte(strings.Repeat(" ", (1<<20)+1)))
				}
			}))
			defer server.Close()
			var receipt any
			err := newClient("a:b").mutationJSON(context.Background(), server.URL+"/tweets", map[string]string{"text": "hello"}, &receipt)
			if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || received.Load() != 1 {
				t.Fatalf("err=%v requests=%d", err, received.Load())
			}
		})
	}
}

func TestArticleDraftReceiptPrecedesPublishAndSurvivesFailure(t *testing.T) {
	publishes := 0
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/2/articles/draft":
			return 201, `{"data":{"id":"91"}}`
		case "/2/articles/91/publish":
			publishes++
			return 503, `{}`
		default:
			t.Errorf("unexpected mutation %s", r.path)
			return 500, `{}`
		}
	})
	defer done()
	p := New()
	in := publishingAccount()
	ctx := context.Background()
	first := pendingData{Message: "hello", Settings: pendingSettings{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("published")}, Attempting: true, Confirmed: true}
	created, err := p.FinalizePost(ctx, in.Token, marshal(first), in)
	if err != nil || created.Status != "pending" || publishes != 0 {
		t.Fatalf("draft not separated: %+v %v", created, err)
	}
	var saved pendingData
	if json.Unmarshal(created.PendingData, &saved) != nil || saved.ArticleDraftID != "91" || saved.Attempting || saved.Confirmed {
		t.Fatalf("draft receipt missing: %+v", saved)
	}
	armed, err := p.FinalizePost(ctx, in.Token, created.PendingData, in)
	if err != nil {
		t.Fatal(err)
	}
	ready, err := p.CheckPostStatus(ctx, in.Token, armed.PendingData, in)
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.FinalizePost(ctx, in.Token, ready.PendingData, in)
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || publishes != 1 {
		t.Fatalf("publish=%d err=%v", publishes, err)
	}
	// Recovery sees the durable intent and must not create or publish again.
	_, err = p.CheckPostStatus(ctx, in.Token, ready.PendingData, in)
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || len(*calls) != 4 {
		t.Fatalf("recovery repeated mutation: %v calls=%d", err, len(*calls))
	}
	if !strings.Contains(string(ready.PendingData), `"articleDraftId":"91"`) {
		t.Fatal("known draft lost after publish failure")
	}
}

// Once an Article's draft is saved on X, a count that runs out of time must not
// become a whole-post retry, which would save a second draft.
func TestArticleCountTimeoutAfterItsDraftIsNotRetried(t *testing.T) {
	_, done := fakePublishingX(t, func(r recorded) (int, string) {
		t.Errorf("unexpected mutation %s", r.path)
		return 500, `{}`
	})
	defer done()
	in := publishingAccount()
	pending := pendingData{Message: strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59), ArticleDraftID: "91", Attempting: true, Confirmed: true,
		Settings: pendingSettings{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("published")}}
	_, err := New().FinalizePost(context.Background(), in.Token, marshal(pending), in)
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || errors.Is(err, helpers.ErrTextTooComplex) {
		t.Fatalf("err = %v", err)
	}
}

func TestMissingApplicationCredentialsNeverSend(t *testing.T) {
	t.Setenv("X_API_KEY", "")
	t.Setenv("X_API_SECRET", "")
	var receipt any
	err := newClient("a:b").mutationJSON(context.Background(), "https://api.x.com/2/tweets", map[string]string{"text": "hello"}, &receipt)
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected {
		t.Fatalf("missing config became uncertain: %v", err)
	}
}

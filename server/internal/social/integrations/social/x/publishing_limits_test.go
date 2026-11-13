package x

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

func publishingAccount() *ent.Integration {
	now := time.Now()
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("Premium"))
	return &ent.Integration{InternalID: "1", ProviderIdentifier: "x", Token: "a:b", Profile: ptr("me"),
		VerifiedAccountKey: ptr("x:1"), VerifiedAccountKind: ptr("profile"), VerifiedScopes: []string{"read-write"},
		IdentityVerifiedAt: &now, VerifiedCapabilities: &socialidentity.Capabilities{Version: 1, X: &caps}}
}

func fakePublishingX(t *testing.T, handler func(recorded) (int, string)) (*[]recorded, func()) {
	t.Helper()
	return fakeX(t, func(r recorded) (int, string) {
		if r.path == "/2/users/me" {
			return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"Premium"}}`
		}
		return handler(r)
	})
}

func publicationPaths(post integrations.PostDetails) map[string]func(*ent.Integration) error {
	p := New()
	ctx := context.Background()
	return map[string]func(*ent.Integration) error{
		"pending": func(in *ent.Integration) error {
			_, err := p.PostPending(ctx, "1", "a:b", []integrations.PostDetails{post}, in)
			return err
		},
		"finalize": func(in *ent.Integration) error {
			_, err := p.FinalizePost(ctx, "a:b", marshal(pendingData{Message: post.Message, Attempting: true, Confirmed: true}), in)
			return err
		},
		"comment": func(in *ent.Integration) error {
			_, err := p.Comment(ctx, "1", "42", "", "a:b", []integrations.PostDetails{post}, in)
			return err
		},
		"reply": func(in *ent.Integration) error {
			_, err := p.ReplyTo(ctx, in, "42", post.Message)
			return err
		},
	}
}

// Shots running out of time counting a post's or an Article's links sent
// nothing: the error is the one the publisher retries, not a rejection.
func TestTextTooComplexToCountIsNotARejection(t *testing.T) {
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("Premium"))
	articles := true
	caps.Articles = &articles
	crafted := strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59) // outlasts the longest caption's budget
	for _, article := range []bool{false, true} {
		err := checkPublishingContent(caps, crafted, pendingSettings{ArticleTitle: ptr("Notes"), ArticleStatus: ptr("draft")}, 0, article)
		if !errors.Is(err, helpers.ErrTextTooComplex) || temporalx.FailureType(err) == temporalx.TypePublicationRejected {
			t.Fatalf("article=%v: %v", article, err)
		}
	}
}

func TestPublishingRejectsUnavailableStoredIdentityBeforeNetwork(t *testing.T) {
	var requests atomic.Int32
	connectionServer(t, func(w http.ResponseWriter, r *http.Request) { requests.Add(1) })
	for _, mutate := range []struct {
		name  string
		apply func(*ent.Integration) *ent.Integration
	}{
		{"missing", func(in *ent.Integration) *ent.Integration { return nil }},
		{"missing proof", func(in *ent.Integration) *ent.Integration { in.IdentityVerifiedAt = nil; return in }},
		{"disabled", func(in *ent.Integration) *ent.Integration { in.Disabled = true; return in }},
		{"deleted", func(in *ent.Integration) *ent.Integration { now := time.Now(); in.DeletedAt = &now; return in }},
		{"revoked", func(in *ent.Integration) *ent.Integration { in.RefreshNeeded = true; return in }},
		{"unfinished", func(in *ent.Integration) *ent.Integration { in.InBetweenSteps = true; return in }},
		{"different provider", func(in *ent.Integration) *ent.Integration { in.ProviderIdentifier = "threads"; return in }},
		{"different identity", func(in *ent.Integration) *ent.Integration { in.InternalID = "2"; return in }},
	} {
		for name, publish := range publicationPaths(integrations.PostDetails{Message: "hello"}) {
			t.Run(mutate.name+"/"+name, func(t *testing.T) {
				if err := publish(mutate.apply(publishingAccount())); temporalx.FailureType(err) != temporalx.TypePublicationRejected {
					t.Fatalf("expected unavailable identity, got %v", err)
				}
			})
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("unavailable accounts made %d requests", requests.Load())
	}
}

func TestPublishingRechecksCurrentGrantAndSubscription(t *testing.T) {
	for _, tc := range []struct {
		name, tier, level, native string
		status                    int
		want                      string
		body                      string
	}{
		{name: "downgrade", tier: "None", level: "read-write", want: temporalx.TypePublicationRejected},
		{name: "unknown tier", tier: "FutureTier", level: "read-write", want: temporalx.TypePublicationRejected},
		{name: "read only", tier: "Premium", level: "read", want: temporalx.TypeRefreshToken},
		{name: "missing grant", tier: "Premium", want: temporalx.TypeRefreshToken},
		{name: "account replaced", tier: "Premium", level: "read-write", native: "2", want: temporalx.TypeRefreshToken},
		{name: "revoked", status: 401, want: temporalx.TypeRefreshToken},
		// Shots' app lost v2 access: every account would fail, so none is flagged.
		{name: "app not enrolled", status: 403, body: `{"title":"Client Forbidden","reason":"client-not-enrolled"}`, want: temporalx.TypeAppAccess},
		{name: "rate limited", status: 429},
		{name: "outage", status: 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mutations atomic.Int32
			connectionServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.Path != "/2/users/me" {
					mutations.Add(1)
					t.Error("rejected content must not upload or publish")
					return
				}
				if !strings.Contains(r.Header.Get("Authorization"), `oauth_token="a"`) || !strings.Contains(r.URL.Query().Get("user.fields"), "subscription_type") {
					t.Error("verification must use the current signed token and subscription field")
				}
				w.Header().Set("x-access-level", tc.level)
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				native := tc.native
				if native == "" {
					native = "1"
				}
				if tc.body != "" {
					_, _ = io.WriteString(w, tc.body)
					return
				}
				_, _ = io.WriteString(w, `{"data":{"id":"`+native+`","name":"Me","username":"me","subscription_type":"`+tc.tier+`"}}`)
			})
			for name, publish := range publicationPaths(integrations.PostDetails{Message: strings.Repeat("a", 281)}) {
				t.Run(name, func(t *testing.T) {
					err := publish(publishingAccount())
					if err == nil || (tc.want != "" && temporalx.FailureType(err) != tc.want) ||
						(tc.want == "" && !errors.Is(err, integrations.ErrRefreshUnavailable)) {
						t.Fatalf("unexpected publication result: %v", err)
					}
				})
			}
			if mutations.Load() != 0 {
				t.Fatal("unexpected mutation")
			}
		})
	}
}

func TestPendingContentCannotRetainAnExpiredLongPostAllowance(t *testing.T) {
	tier := "Basic"
	calls, done := fakeX(t, func(r recorded) (int, string) {
		if r.path == "/2/users/me" {
			return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"` + tier + `"}}`
		}
		t.Error("downgraded pending post must not be sent")
		return 500, `{}`
	})
	defer done()
	p := New()
	ctx := context.Background()
	in := publishingAccount()
	res, err := p.PostPending(ctx, "1", "a:b", []integrations.PostDetails{{ID: "p", Message: strings.Repeat("a", 281)}}, in)
	if err != nil {
		t.Fatal(err)
	}
	armed, err := p.FinalizePost(ctx, "a:b", res[0].PendingData, in)
	if err != nil {
		t.Fatal(err)
	}
	ready, err := p.CheckPostStatus(ctx, "a:b", armed.PendingData, in)
	if err != nil {
		t.Fatal(err)
	}
	tier = "None"
	_, err = p.FinalizePost(ctx, "a:b", ready.PendingData, in)
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected || len(*calls) != 2 {
		t.Fatalf("expected fresh downgrade rejection, got %v (%d calls)", err, len(*calls))
	}
}

func TestPublishingPreservesApprovedLongTextAndLinks(t *testing.T) {
	t.Setenv("STRIP_LINKS_FROM_X_POSTS", "true")
	text := strings.Repeat("a", 281) + " https://example.test/article"
	for name, publish := range publicationPaths(integrations.PostDetails{Message: text}) {
		t.Run(name, func(t *testing.T) {
			calls, done := fakePublishingX(t, func(r recorded) (int, string) { return 201, `{"data":{"id":"99"}}` })
			defer done()
			if err := publish(publishingAccount()); err != nil {
				t.Fatal(err)
			}
			if New().StripLinks() {
				t.Fatal("scheduler would remove approved links")
			}
			if name == "pending" {
				if len(*calls) != 1 {
					t.Fatal("pending made a mutation")
				}
				return
			}
			var body tweetBody
			if len(*calls) != 2 || json.Unmarshal((*calls)[1].body, &body) != nil || body.Text != text {
				t.Fatal("published text was changed")
			}
		})
	}
}

func TestPublishingRejectsInvalidThreadBeforeRootUpload(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) { t.Error("invalid thread made a mutation"); return 500, `{}` })
	defer done()
	_, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{
		{ID: "root", Message: "hello", Media: []integrations.MediaContent{{Path: apiBase + "/photo.png"}}},
		{ID: "reply", Message: strings.Repeat("a", 25001)},
	}, publishingAccount())
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected || len(*calls) != 1 {
		t.Fatalf("invalid thread: %v", err)
	}
}

func TestPublishingRejectsUnverifiedArticleAndQuote(t *testing.T) {
	for _, article := range []bool{false, true} {
		t.Run(map[bool]string{false: "quote", true: "article"}[article], func(t *testing.T) {
			calls, done := fakeX(t, func(r recorded) (int, string) {
				if r.path == "/2/users/me" {
					return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"Basic"}}`
				}
				t.Error("unverified feature made a mutation")
				return 500, `{}`
			})
			defer done()
			settings := pendingSettings{QuoteTweetID: ptr("42")}
			if article {
				settings = pendingSettings{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("published")}
			}
			post := integrations.PostDetails{Message: "hello", Settings: marshal(settings), Media: []integrations.MediaContent{{Path: apiBase + "/pic.png"}}}
			_, pendingErr := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{post}, publishingAccount())
			_, finalErr := New().FinalizePost(context.Background(), "a:b", marshal(pendingData{Message: "hello", Settings: settings, Attempting: true, Confirmed: true}), publishingAccount())
			if temporalx.FailureType(pendingErr) != temporalx.TypePublicationRejected || temporalx.FailureType(finalErr) != temporalx.TypePublicationRejected || len(*calls) != 2 {
				t.Fatalf("unverified feature: %v, %v", pendingErr, finalErr)
			}
		})
	}
}

func TestPublishingMissingReceiptDoesNotReportSuccess(t *testing.T) {
	for _, response := range []string{`{}`, `{"data":{}}`} {
		t.Run(response, func(t *testing.T) {
			calls, done := fakePublishingX(t, func(r recorded) (int, string) { return 201, response })
			defer done()
			_, err := New().ReplyTo(context.Background(), publishingAccount(), "42", "hello")
			if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || !strings.Contains(err.Error(), "avoid duplicates") || len(*calls) != 2 {
				t.Fatalf("unknown outcome reported success or retried: %v", err)
			}
		})
	}
}

func TestPublishingRejectsEmptyInputAndStaleCredential(t *testing.T) {
	var requests atomic.Int32
	connectionServer(t, func(w http.ResponseWriter, r *http.Request) { requests.Add(1) })
	p := New()
	ctx := context.Background()
	in := publishingAccount()
	_, pendingErr := p.PostPending(ctx, "1", "a:b", nil, in)
	_, replyErr := p.Comment(ctx, "1", "42", "", "a:b", nil, in)
	_, staleErr := publishingLimits(ctx, "old:credential", in)
	for _, err := range []error{pendingErr, replyErr, staleErr} {
		if temporalx.FailureType(err) != temporalx.TypePublicationRejected {
			t.Fatalf("invalid input was not rejected: %v", err)
		}
	}
	if requests.Load() != 0 {
		t.Fatal("invalid input made a provider request")
	}
}

func TestAutoPlugUsesCurrentAccountLimits(t *testing.T) {
	calls, done := fakeX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/2/tweets/42":
			return 200, `{"data":{"id":"42","public_metrics":{"like_count":2}}}`
		case "/2/users/me":
			return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"None"}}`
		default:
			t.Error("automated reply used an obsolete allowance")
			return 500, `{}`
		}
	})
	defer done()
	posted, err := New().AutoPlugPost(context.Background(), publishingAccount(), "42", map[string]string{"likesAmount": "1", "post": strings.Repeat("a", 281)})
	if posted || temporalx.FailureType(err) != temporalx.TypePublicationRejected || len(*calls) != 2 {
		t.Fatalf("auto plug: %v, %v", posted, err)
	}
}

func TestReplyDoesNotRetryAmbiguousProviderFailure(t *testing.T) {
	calls, done := fakePublishingX(t, func(r recorded) (int, string) { return 500, `{}` })
	defer done()
	_, err := New().ReplyTo(context.Background(), publishingAccount(), "42", "hello")
	if err == nil || len(*calls) != 2 {
		t.Fatalf("ambiguous reply retried or succeeded: %v", err)
	}
}

func TestCommentRechecksSubscriptionAfterMediaUpload(t *testing.T) {
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
	var reads atomic.Int32
	calls, done := fakeX(t, func(r recorded) (int, string) {
		switch r.path {
		case "/2/users/me":
			tier := "Premium"
			if reads.Add(1) > 1 {
				tier = "None"
			}
			return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"` + tier + `"}}`
		case "/pic.png":
			return 200, string(pngBytes())
		case "/2/media/upload/initialize", "/2/media/upload/11/finalize":
			return 200, `{"data":{"id":"11"}}`
		case "/2/media/upload/11/append":
			return 200, `{}`
		default:
			t.Error("reply published after account downgrade")
			return 500, `{}`
		}
	})
	defer done()
	_, err := New().Comment(context.Background(), "1", "42", "", "a:b", []integrations.PostDetails{{
		ID: "reply", Message: strings.Repeat("a", 281), Media: []integrations.MediaContent{{Path: apiBase + "/pic.png"}},
	}}, publishingAccount())
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected || reads.Load() != 2 || len(*calls) != 6 {
		t.Fatalf("reply did not recheck after upload: %v, %d reads, %d calls", err, reads.Load(), len(*calls))
	}
}

func TestEnterpriseQuoteUsesNativeReferenceAndRevocationStopsScheduledWork(t *testing.T) {
	t.Setenv("PLATFORM_X_ENTERPRISE_QUOTES_ENABLED", "true")
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		if r.path != "/2/tweets" {
			t.Errorf("unexpected endpoint %s", r.path)
		}
		var body map[string]any
		if err := json.Unmarshal(r.body, &body); err != nil {
			t.Fatal(err)
		}
		if body["quote_tweet_id"] != "42" || body["text"] != "A native quote" {
			t.Errorf("body=%s", r.body)
		}
		return 201, `{"data":{"id":"123456"}}`
	})
	defer done()
	settings := pendingSettings{QuoteTweetID: ptr("42")}
	_, err := New().FinalizePost(context.Background(), "a:b", marshal(pendingData{Message: "A native quote", Settings: settings, Attempting: true, Confirmed: true}), publishingAccount())
	if err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 {
		t.Fatalf("calls=%+v", *calls)
	}
	t.Setenv("PLATFORM_X_ENTERPRISE_QUOTES_ENABLED", "")
	_, err = New().FinalizePost(context.Background(), "a:b", marshal(pendingData{Message: "A native quote", Settings: settings, Attempting: true, Confirmed: true}), publishingAccount())
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected || len(*calls) != 3 {
		t.Fatalf("revoked scheduled quote mutated: calls=%+v err=%v", *calls, err)
	}
}

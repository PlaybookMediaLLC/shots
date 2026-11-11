package x

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

func connectionServer(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	t.Setenv("X_API_KEY", "fixture-key")
	t.Setenv("X_API_SECRET", "fixture-secret")
	server := httptest.NewServer(handler)
	previous := apiBase
	apiBase = server.URL
	t.Cleanup(func() { apiBase = previous; server.Close() })
}

func TestConnectionRequiresActualGrantAndIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, level, payload string
		status               int
		valid, transient     bool
		// appLevel: X refused Shots' app access, which no account can fix.
		appLevel bool
	}{
		{name: "write", level: "read-write", valid: true},
		{name: "write and DMs", level: "read-write-directmessages", valid: true},
		{name: "missing grant"},
		{name: "read only", level: "read"},
		{name: "OAuth2 scopes are not OAuth1 grant", level: "tweet.read tweet.write"},
		{name: "combined headers", level: "read-write, read"},
		{name: "wrong identity", level: "read-write", payload: `{"data":{"id":"2","name":"Other","username":"other"}}`},
		{name: "no identity", level: "read-write", payload: `{}`},
		{name: "partial errors", level: "read-write", payload: `{"data":{"id":"1","name":"Me","username":"me"},"errors":[{"detail":"secret-canary"}]}`},
		{name: "bad handle", level: "read-write", payload: `{"data":{"id":"1","name":"Me","username":"https://bad.example"}}`},
		{name: "oversized response", level: "read-write", payload: strings.Repeat("x", (1<<20)+1)},
		{name: "revoked", status: 401},
		{name: "forbidden", status: 403},
		{name: "app not enrolled", status: 403, payload: `{"title":"Client Forbidden","reason":"client-not-enrolled"}`, appLevel: true},
		{name: "rate limited", status: 429, transient: true},
		{name: "outage", status: 503, transient: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			connectionServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.Path != "/2/users/me" || !strings.Contains(r.Header.Get("Authorization"), `oauth_token="access"`) {
					t.Error("verification must use signed read-only identity lookup")
				}
				if tc.level != "" {
					w.Header().Set("x-access-level", tc.level)
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				payload := tc.payload
				if payload == "" {
					payload = `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"Premium","profile_image_url":"https://images.example.test/me.jpg"}}`
				}
				_, _ = io.WriteString(w, payload)
			})
			auth, err := newClient("access:secret").verifiedIdentity(context.Background(), "1")
			if tc.valid {
				if err != nil || auth == nil || auth.Verification.Validate("x", "1") != nil || !auth.NonExpiring || auth.ExpiresIn != 0 || (auth.Verification.Capabilities.X.LongPostMaxWeightedCharacters == nil || *auth.Verification.Capabilities.X.LongPostMaxWeightedCharacters != 25000) {
					t.Fatalf("verified connection missing or invented capability: %v", err)
				}
			} else if auth != nil || err == nil || strings.Contains(err.Error(), "secret-canary") || errors.Is(err, integrations.ErrRefreshUnavailable) != tc.transient ||
				errors.Is(err, integrations.ErrAppCredentialsRefused) != tc.appLevel {
				t.Fatalf("unsafe/misclassified rejected connection: %v", err)
			}
		})
	}
}

func TestConnectionRejectsRedirectsAndHonorsCancellation(t *testing.T) {
	var redirects atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirects.Add(1) }))
	defer target.Close()
	connectionServer(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) })
	if _, err := newClient("access:secret").verifiedIdentity(context.Background(), "1"); err == nil || redirects.Load() != 0 {
		t.Fatal("identity verification followed a credential-bearing redirect")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := newClient("access:secret").verifiedIdentity(ctx, "1"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was not preserved")
	}
}

func TestConnectionExchangeRejectsMalformedTokensBeforeIdentityCall(t *testing.T) {
	for _, body := range []string{"", "oauth_token=a&oauth_token_secret=b", "oauth_token=&oauth_token_secret=b&user_id=1", "oauth_token=a&oauth_token_secret=b&user_id=1&user_id=2", "oauth_token=a&oauth_token=a&oauth_token_secret=b&user_id=1", "oauth_token=a%3Ab&oauth_token_secret=b&user_id=1"} {
		t.Run(body, func(t *testing.T) {
			var calls atomic.Int32
			connectionServer(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.WriteString(w, body) })
			if auth, err := New().Authenticate(context.Background(), integrations.AuthenticateParams{Code: "verifier", CodeVerifier: "request:secret"}, nil); auth != nil || err == nil || calls.Load() != 1 {
				t.Fatal("malformed exchange accepted or used for identity lookup")
			}
		})
	}
}

func TestConnectionTimeoutDoesNotBecomeAnInvalidGrant(t *testing.T) {
	connectionServer(t, func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := newClient("access:secret").verifiedIdentity(ctx, "1"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("deadline was not preserved")
	}
}

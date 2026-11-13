package mastodoncustom

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/credentialcipher"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/mastodon"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"go.temporal.io/sdk/temporal"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func fixtureProvider(handler http.HandlerFunc) *Provider {
	return newProvider(&http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		recorder := httptest.NewRecorder()
		handler(recorder, r)
		return recorder.Result(), nil
	})})
}

func clientInfo(origin string) *integrations.ClientInformation {
	return &integrations.ClientInformation{ClientID: "client+id", ClientSecret: "secret-canary", InstanceURL: origin}
}

func authParams() integrations.AuthenticateParams {
	return integrations.AuthenticateParams{Code: "code-canary", CodeVerifier: strings.Repeat("v", 64)}
}

func storedIntegration(t *testing.T, origin string) *ent.Integration {
	t.Helper()
	t.Setenv("PLATFORM_SOCIAL_ENCRYPTION_KEY", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
	data, err := json.Marshal(clientInfo(origin))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := credentialcipher.Seal(string(data), "custom-instance")
	if err != nil {
		t.Fatal(err)
	}
	return &ent.Integration{CustomInstanceDetails: &sealed}
}

func TestCustomInstanceAuthorization(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://app.example.com/")
	calls := 0
	p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Scheme != "https" || r.URL.Host != "example.social" {
			t.Errorf("wrong instance %s", r.URL)
		}
		_ = r.ParseForm()
		switch r.URL.Path {
		case "/api/v1/apps":
			if r.Form.Get("redirect_uris") != "https://app.example.com/integrations/social/mastodon-custom" || r.Form.Get("scopes") != strings.Join(scopes, " ") {
				t.Errorf("incorrect registration fields")
			}
			_, _ = io.WriteString(w, `{"client_id":"client+id","client_secret":"secret-canary"}`)
		case "/oauth/token":
			if r.Form.Get("redirect_uri") != "https://app.example.com/integrations/social/mastodon-custom" ||
				r.Form.Get("code_verifier") != authParams().CodeVerifier || r.Form.Get("code") != "code-canary" || r.Form.Get("client_secret") != "secret-canary" {
				t.Errorf("incorrect token exchange fields")
			}
			_, _ = io.WriteString(w, `{"access_token":"token-canary","token_type":"Bearer","scope":"read:accounts write:media write:statuses read:search read:statuses"}`)
		case "/api/v2/instance":
			if r.Method != http.MethodGet || r.Header.Get("Authorization") != "" || r.URL.RawQuery != "" {
				t.Fatal("public capability discovery received credentials")
			}
			_, _ = io.WriteString(w, instanceFixture)
		case "/api/v1/accounts/verify_credentials":
			if r.Header.Get("Authorization") != "Bearer token-canary" {
				t.Error("missing bearer")
			}
			_, _ = io.WriteString(w, `{"id":"7","acct":"me","username":"me","avatar":"https://cdn.example.com/me.png"}`)
		default:
			t.Fatalf("unexpected request %s", r.URL.Path)
		}
	})
	client, err := p.ExternalURL(context.Background(), "EXAMPLE.social/")
	if err != nil || client.InstanceURL != "https://example.social" {
		t.Fatalf("registration: %v", err)
	}
	generated, err := p.GenerateAuthURL(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(generated.URL)
	if err != nil {
		t.Fatal(err)
	}
	challenge := sha256.Sum256([]byte(generated.CodeVerifier))
	q := u.Query()
	if u.Host != "example.social" || u.Path != "/oauth/authorize" || q.Get("client_id") != "client+id" ||
		q.Get("redirect_uri") != "https://app.example.com/integrations/social/mastodon-custom" || q.Get("state") != generated.State || len(generated.State) < 32 ||
		q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") != base64.RawURLEncoding.EncodeToString(challenge[:]) || q.Has("client_secret") {
		t.Fatalf("invalid authorization URL")
	}
	auth, err := p.Authenticate(context.Background(), authParams(), client)
	if err != nil {
		t.Fatal(err)
	}
	if auth.ID != "mastodon:example.social:7" || auth.Username != "me@example.social" || auth.Name != "me" ||
		auth.AccessToken != "token-canary" || auth.RefreshToken != "" || !auth.NonExpiring || auth.ExpiresIn != 0 || calls != 4 {
		t.Fatal("account identity or token semantics were not verified")
	}
	if auth.Verification.Validate(identifier, auth.ID) != nil || auth.Verification.Capabilities.MaxCharacters != 1024 ||
		auth.Verification.Capabilities.MediaDescriptionLimit == nil || *auth.Verification.Capabilities.MediaDescriptionLimit != 1500 {
		t.Fatal("verified account is missing the selected instance's capabilities")
	}
}

func TestCustomInstanceIdentityAndPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, token, account       string
		wantError, wantAccountCall bool
	}{
		{"broad grants", `{"access_token":"tok","token_type":"bearer","scope":"read write"}`, `{"id":"7","username":"me","acct":"me"}`, false, true},
		{"missing media grant", `{"access_token":"tok","token_type":"Bearer","scope":"read:accounts write:statuses"}`, "{}", true, false},
		{"missing scopes", `{"access_token":"tok","token_type":"Bearer"}`, "{}", true, false},
		{"missing token", `{"token_type":"Bearer","scope":"read write"}`, "{}", true, false},
		{"wrong token type", `{"access_token":"tok","token_type":"MAC","scope":"read write"}`, "{}", true, false},
		{"header injection", `{"access_token":"tok\r\nsecret","token_type":"Bearer","scope":"read write"}`, "{}", true, false},
		{"missing identity", `{"access_token":"tok","token_type":"Bearer","scope":"read write"}`, `{"username":"me","acct":"me"}`, true, true},
		{"remote identity", `{"access_token":"tok","token_type":"Bearer","scope":"read write"}`, `{"id":"7","username":"me","acct":"me@other.social"}`, true, true},
		{"path identity", `{"access_token":"tok","token_type":"Bearer","scope":"read write"}`, `{"id":"../7","username":"me","acct":"me"}`, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accountCalled := false
			p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v2/instance" {
					_, _ = io.WriteString(w, instanceFixture)
				} else if r.URL.Path == "/oauth/token" {
					_, _ = io.WriteString(w, tc.token)
				} else {
					accountCalled = true
					_, _ = io.WriteString(w, tc.account)
				}
			})
			first, err := p.Authenticate(context.Background(), authParams(), clientInfo("one.social"))
			if (err != nil) != tc.wantError || accountCalled != tc.wantAccountCall {
				t.Fatalf("verification mismatch: %v", err)
			}
			if tc.wantError {
				return
			}
			second, err := p.Authenticate(context.Background(), authParams(), clientInfo("two.social"))
			if err != nil || first.ID == second.ID {
				t.Fatal("numeric account IDs collided across servers")
			}
		})
	}
}

func TestCustomInstanceFailsClosed(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	calls := 0
	p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) { calls++ })
	for _, origin := range []string{"", "http://example.social", "https://127.0.0.1", "https://localhost", "https://user:pass@example.social", "https://example.social/path", "https://example.social:443"} {
		if _, err := p.ExternalURL(context.Background(), origin); err == nil {
			t.Errorf("accepted %s", origin)
		}
		if _, err := p.GenerateAuthURL(context.Background(), clientInfo(origin)); err == nil {
			t.Errorf("authorized %s", origin)
		}
		if _, err := p.Authenticate(context.Background(), authParams(), clientInfo(origin)); err == nil {
			t.Errorf("exchanged %s", origin)
		}
	}
	if _, err := p.GenerateAuthURL(context.Background(), nil); err == nil {
		t.Error("accepted missing client")
	}
	if _, err := p.Authenticate(context.Background(), integrations.AuthenticateParams{Code: "code"}, clientInfo("example.social")); err == nil {
		t.Error("accepted missing verifier")
	}
	if calls != 0 {
		t.Fatalf("invalid connection reached provider %d times", calls)
	}
}

func TestCustomInstanceRejectsProviderFailuresWithoutSecretsOrRetries(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"denied", 400, `{"error":"secret-canary code-canary token-canary"}`},
		{"rate limited", 429, `secret-canary`},
		{"server failure", 500, `secret-canary`},
		{"redirect", 302, `secret-canary`},
		{"invalid json", 200, `secret-canary`},
		{"oversized", 200, strings.Repeat(" ", responseLimit) + `{}`},
		{"empty credentials", 200, `{}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.Header().Set("Location", "https://other.social/steal")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			_, err := p.ExternalURL(context.Background(), "example.social")
			if err == nil || strings.Contains(err.Error(), "canary") || calls != 1 {
				t.Fatalf("unsafe registration failure: %v, %d calls", err, calls)
			}
			calls = 0
			_, err = p.Authenticate(context.Background(), authParams(), clientInfo("example.social"))
			if err == nil || strings.Contains(err.Error(), "canary") || calls != 1 {
				t.Fatalf("unsafe exchange failure: %v, %d calls", err, calls)
			}
		})
	}
}

func TestCustomInstancePublishingBindsStoredOrigin(t *testing.T) {
	integration := storedIntegration(t, "example.social")
	calls := 0
	p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Host != "example.social" || r.Header.Get("Authorization") != "Bearer token-canary" {
			t.Error("wrong token destination")
		}
		if r.URL.Path == "/api/v1/statuses" {
			_, _ = io.WriteString(w, `{"id":"42"}`)
		} else {
			_, _ = io.WriteString(w, `{"id":"9"}`)
		}
	})
	posts := []integrations.PostDetails{{ID: "post", Message: "test"}}
	pending, err := p.PostPending(context.Background(), "account", "token-canary", posts, integration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CheckPostStatus(context.Background(), "token-canary", pending[0].PendingData, integration); err != nil {
		t.Fatal(err)
	}
	result, err := p.FinalizePost(context.Background(), "token-canary", pending[0].PendingData, integration)
	if err != nil || result.PostID != "42" {
		t.Fatalf("finalize: %v", err)
	}
	if _, err := p.Post(context.Background(), "account", "token-canary", posts, integration); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Comment(context.Background(), "account", "42", "", "token-canary", posts, integration); err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("expected three publications, got %d", calls)
	}
	bad := "invalid-encrypted-details"
	for _, stored := range []*ent.Integration{nil, {}, {CustomInstanceDetails: &bad}} {
		if _, err := p.Post(context.Background(), "", "token-canary", posts, stored); err == nil {
			t.Error("post accepted missing origin")
		}
		if _, err := p.PostPending(context.Background(), "", "token-canary", posts, stored); err == nil {
			t.Error("pending accepted missing origin")
		}
		if _, err := p.Comment(context.Background(), "", "42", "", "token-canary", posts, stored); err == nil {
			t.Error("comment accepted missing origin")
		}
	}
	for _, origin := range []string{"https://other.social", "https://127.0.0.1", "https://example.social/path", "https://example.social/"} {
		raw, _ := json.Marshal(mastodon.PendingData{URL: origin, MediaIDs: []string{"9"}})
		if _, err := p.CheckPostStatus(context.Background(), "token-canary", raw, integration); err == nil {
			t.Errorf("poll accepted %s", origin)
		}
		if _, err := p.FinalizePost(context.Background(), "token-canary", raw, integration); err == nil {
			t.Errorf("finalize accepted %s", origin)
		}
	}
	if _, err := p.Post(context.Background(), "", "token-canary", nil, integration); err == nil {
		t.Error("empty post accepted")
	}
	if calls != 3 {
		t.Fatalf("rejected operation reached provider, calls %d", calls)
	}
}

func TestCustomInstancePublishingFailureRedactsServerEchoes(t *testing.T) {
	integration := storedIntegration(t, "example.social")
	p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, `{"error":"token-canary secret-canary"}`)
	})
	_, err := p.Comment(context.Background(), "", "parent", "", "token-canary", []integrations.PostDetails{{ID: "comment", Message: "hi"}}, integration)
	if temporalx.FailureType(err) != temporalx.TypeRefreshToken {
		t.Fatalf("wrong failure: %v", err)
	}
	var app *temporal.ApplicationError
	var details temporalx.FailureDetails
	if !errors.As(err, &app) || app.Details(&details) != nil || details.Identifier != identifier {
		t.Fatal("missing provider failure context")
	}
	encoded, _ := json.Marshal(details)
	if strings.Contains(string(encoded), "canary") {
		t.Fatal("provider echoed a credential into durable failure details")
	}
}

func TestCustomInstancePreservesSafeFailureClassification(t *testing.T) {
	integration := storedIntegration(t, "example.social")
	for _, tc := range []struct {
		status       int
		marker, want string
	}{
		{403, "Your login is currently disabled", temporalx.TypeRefreshToken},
		{422, "not finished processing", temporalx.TypeBadBody},
		{422, "could not be found", temporalx.TypeBadBody},
	} {
		p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = io.WriteString(w, tc.marker+" token-canary secret-canary")
		})
		_, err := p.Comment(context.Background(), "", "parent", "", "token-canary", []integrations.PostDetails{{ID: "comment", Message: "hi"}}, integration)
		if temporalx.FailureType(err) != tc.want {
			t.Fatalf("lost failure classification: %v", err)
		}
		var app *temporal.ApplicationError
		var details temporalx.FailureDetails
		if !errors.As(err, &app) || app.Details(&details) != nil {
			t.Fatal("missing failure details")
		}
		encoded, _ := json.Marshal(details)
		if strings.Contains(string(encoded), "canary") {
			t.Fatal("classification retained credential echo")
		}
	}
}

// A delete goes only to the connection's own instance, through the guarded client.
func TestCustomInstanceDeleteBindsStoredOrigin(t *testing.T) {
	integration := storedIntegration(t, "example.social")
	integration.Token = "token-canary"
	var got []string
	p := fixtureProvider(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.URL.Host+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	})
	if err := p.DeletePost(context.Background(), integration, "42"); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "DELETE example.social/api/v1/statuses/42 Bearer token-canary" {
		t.Fatalf("requests %v", got)
	}
	if err := p.DeletePost(context.Background(), &ent.Integration{Token: "token-canary"}, "42"); err == nil || len(got) != 1 {
		t.Fatalf("a connection without an instance was called: %v", err)
	}
}

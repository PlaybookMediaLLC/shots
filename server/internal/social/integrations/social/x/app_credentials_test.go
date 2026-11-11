package x

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

func TestAppCredentialsAreCheckedWithAppOnlyAuth(t *testing.T) {
	status := http.StatusOK
	connectionServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/oauth2/token" || r.ParseForm() != nil || r.PostForm.Get("grant_type") != "client_credentials" {
			t.Errorf("unexpected token request %s %s", r.Method, r.URL.Path)
		}
		// X decodes the URL-encoded key and secret and accepts only its own.
		user, pass, _ := r.BasicAuth()
		key, keyErr := url.QueryUnescape(user)
		secret, secretErr := url.QueryUnescape(pass)
		if keyErr != nil || secretErr != nil || key != "fixture-key" || secret != "fixture-secret" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.WriteHeader(status)
	})

	if err := New().VerifyAppCredentials(context.Background()); err != nil {
		t.Fatalf("good app keys were refused: %v", err)
	}
	// The check sends the keys exactly as the signer does: a key with a stray
	// newline breaks signing, so it must not pass here.
	t.Setenv("X_API_KEY", "fixture-key\n")
	if err := New().VerifyAppCredentials(context.Background()); err == nil {
		t.Fatal("a key the signer would send broken passed the check")
	}
	t.Setenv("X_API_KEY", "fixture-key")
	status = http.StatusForbidden
	if err := New().VerifyAppCredentials(context.Background()); !errors.Is(err, integrations.ErrAppCredentialsRefused) {
		t.Fatalf("refused app keys were not called refused: %v", err)
	}
	// An outage or rate limit says nothing about the keys: unchecked, not refused.
	for _, unavailable := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		status = unavailable
		if err := New().VerifyAppCredentials(context.Background()); err == nil || errors.Is(err, integrations.ErrAppCredentialsRefused) {
			t.Fatalf("status %d: %v", unavailable, err)
		}
	}
	status = http.StatusOK
	t.Setenv("X_API_SECRET", "")
	if err := New().VerifyAppCredentials(context.Background()); err == nil {
		t.Fatal("missing app keys passed")
	}
}

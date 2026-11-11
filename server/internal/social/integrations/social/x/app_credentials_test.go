package x

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAppCredentialsAreCheckedWithAppOnlyAuth(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	t.Setenv("X_API_KEY", "fixture-key")
	t.Setenv("X_API_SECRET", "fixture-secret")
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, secret, ok := r.BasicAuth()
		if r.Method != http.MethodPost || r.URL.Path != "/oauth2/token" || !ok || key != "fixture-key" || secret != "fixture-secret" ||
			r.ParseForm() != nil || r.PostForm.Get("grant_type") != "client_credentials" {
			t.Errorf("unexpected token request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	old := apiBase
	apiBase = server.URL
	defer func() { apiBase = old }()

	if err := New().VerifyAppCredentials(context.Background()); err != nil {
		t.Fatalf("good app keys were refused: %v", err)
	}
	status = http.StatusForbidden
	if err := New().VerifyAppCredentials(context.Background()); err == nil {
		t.Fatal("refused app keys passed")
	}
	t.Setenv("X_API_SECRET", "")
	if err := New().VerifyAppCredentials(context.Background()); err == nil {
		t.Fatal("missing app keys passed")
	}
}

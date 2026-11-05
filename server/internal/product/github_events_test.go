package product

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestRepositoryFileReadsOnlyTheSourceRepository(t *testing.T) {
	const raw = "https://raw.githubusercontent.com/Acme/App/main/docs/shot.png"
	for imageURL, want := range map[string]string{
		"https://github.com/acme/app/blob/main/docs/shot.png?raw=true": raw[:34] + "acme/app/main/docs/shot.png",
		"https://github.com/acme/app/raw/main/docs/shot.png":           raw[:34] + "acme/app/main/docs/shot.png",
		raw: raw,
		"https://raw.githubusercontent.com/acme/app/feature/x/a%20b.png":     raw[:34] + "acme/app/feature/x/a%20b.png",
		"https://github.com/acme/other/blob/main/shot.png?raw=true":          "",
		"https://raw.githubusercontent.com/acme/app/../other/main/shot.png":  "",
		"https://raw.githubusercontent.com/acme/app/%2e%2e/other/main/x.png": "",
		"https://github.com/acme/app/pull/1":                                 "",
		"https://github.com/user-attachments/assets/0f1c":                    "",
		"http://raw.githubusercontent.com/acme/app/main/shot.png":            "",
		"https://raw.githubusercontent.com.evil.test/acme/app/main/shot.png": "",
		"https://private-user-images.githubusercontent.com/1/2.png?jwt=x":    "",
	} {
		got, ok := repositoryFile(imageURL, "acme/App")
		if got != want || ok != (want != "") {
			t.Errorf("repositoryFile(%q) = %q, %v; want %q", imageURL, got, ok, want)
		}
	}
}

// The review's probes: readiness reached a private address directly, and by
// following a redirect from a registered host. Both are refused now, and the
// production transport refuses a private address it resolves to.
func TestDeploymentReadinessRefusesPrivateDestinations(t *testing.T) {
	ctx := context.Background()
	c := &Configuration{}
	for _, page := range []string{"https://127.0.0.1/dummy", "https://[::1]/dummy", "https://10.1.2.3/dummy",
		"https://169.254.169.254/dummy", "https://user:secret@app.example.test/"} {
		if err := c.ready(ctx, page); !errors.Is(err, errUnsafeDeploymentURL) {
			t.Errorf("ready(%q) err=%v", page, err)
		}
	}
	hits := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "http://10.0.0.7/internal", http.StatusFound)
		}
	}))
	defer server.Close()
	// routedClient (github_events_integration_test.go) sends example.com to the server.
	c.web = routedClient(server)
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	if err := c.ready(ctx, "https://example.com:"+port+"/start"); !errors.Is(err, errUnsafeDeploymentURL) || hits != 1 {
		t.Fatalf("redirect to a private address err=%v hits=%d", err, hits)
	}
	if err := c.ready(ctx, "https://example.com:"+port+"/live"); err != nil {
		t.Fatalf("a public page that answers: %v", err)
	}
}

func TestSameOriginComparesSchemeHostAndPort(t *testing.T) {
	deployed, _ := url.Parse("https://app.example.com")
	for page, want := range map[string]bool{
		"https://APP.example.com/pricing": true, "https://app.example.com:443/": true,
		"http://app.example.com/": false, "https://app.example.com:8443/": false, "https://other.example.com/": false,
	} {
		parsed, _ := url.Parse(page)
		if sameOrigin(parsed, deployed) != want {
			t.Errorf("sameOrigin(%q) = %v, want %v", page, !want, want)
		}
	}
}

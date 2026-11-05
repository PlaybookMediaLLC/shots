package capture

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestCaptureDownloadsFromTheAPIHostOnly(t *testing.T) {
	shot := testPNG(t)
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/image":
			_, _ = w.Write(shot)
		case r.URL.Path == "/text":
			_, _ = w.Write([]byte("<html>not an image</html>"))
		case r.URL.Query().Get("url") == "https://text.test/":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
				"data": map[string]any{"screenshot": map[string]string{"url": server.URL + "/text"}}})
		case r.URL.Query().Get("url") == "https://app.acme.test/" && r.URL.Query().Get("screenshot") == "true":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
				"data": map[string]any{"screenshot": map[string]string{"url": server.URL + "/image"}}})
		case r.URL.Query().Get("url") == "https://evil.test/":
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
				"data": map[string]any{"screenshot": map[string]string{"url": "http://169.254.169.254/latest"}}})
		default:
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "fail", "data": map[string]string{"message": "rate limited"}})
		}
	}))
	defer server.Close()
	client := &Client{API: server.URL, HTTP: server.Client()}
	body, err := client.Capture(context.Background(), "https://app.acme.test/")
	if err != nil || !bytes.Equal(body, shot) {
		t.Fatalf("capture=%q err=%v", body, err)
	}
	if _, err := client.Capture(context.Background(), "https://evil.test/"); err == nil {
		t.Fatal("a screenshot URL on an internal address was downloaded")
	}
	if _, err := client.Capture(context.Background(), "https://down.test/"); err == nil {
		t.Fatal("a failed capture returned an image")
	}
	if _, err := client.Capture(context.Background(), "https://text.test/"); err == nil {
		t.Fatal("a response that is not an image was returned as a screenshot")
	}
	// The page check sits below every caller, before the API is asked.
	for _, page := range []string{"http://127.0.0.1/admin", "https://[::1]/", "https://10.1.2.3/", "http://169.254.169.254/latest", "https://intranet.local/"} {
		if _, err := client.Capture(context.Background(), page); !errors.Is(err, ErrUnsafeURL) {
			t.Errorf("Capture(%q) err=%v, want ErrUnsafeURL", page, err)
		}
	}
}

// The review's probe: the API host answered /image with a redirect to another
// origin, and the download followed it. Every hop is now checked.
func TestCaptureDownloadRefusesAHostChangingRedirect(t *testing.T) {
	reached := false
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		_, _ = w.Write([]byte("dummy-private-response"))
	}))
	defer other.Close()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image" {
			http.Redirect(w, r, other.URL+"/secret", http.StatusFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
			"data": map[string]any{"screenshot": map[string]string{"url": server.URL + "/image"}}})
	}))
	defer server.Close()
	client := &Client{API: server.URL, HTTP: server.Client()}
	if _, err := client.Capture(context.Background(), "https://app.acme.test/"); !errors.Is(err, ErrUnsafeURL) || reached {
		t.Fatalf("err=%v reached=%v", err, reached)
	}
}

// The production client dials public addresses only, so even the API host
// cannot be a loopback service.
func TestFromEnvironmentRefusesPrivateAddresses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("the production transport reached a loopback server")
	}))
	defer server.Close()
	t.Setenv("SCREENSHOT_API_URL", server.URL)
	if _, err := FromEnvironment().Capture(context.Background(), "https://app.acme.test/"); err == nil {
		t.Fatal("capture through a loopback API succeeded")
	}
}

func TestCaptureOptionsAndPublicPageURL(t *testing.T) {
	var query map[string]string
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image" {
			_, _ = w.Write(testPNG(t))
			return
		}
		query = map[string]string{"colorScheme": r.URL.Query().Get("colorScheme"), "force": r.URL.Query().Get("force"),
			"isMobile": r.URL.Query().Get("viewport.isMobile"), "width": r.URL.Query().Get("viewport.width")}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
			"data": map[string]any{"screenshot": map[string]string{"url": server.URL + "/image"}}})
	}))
	defer server.Close()
	client := &Client{API: server.URL, HTTP: server.Client()}
	if _, err := client.CaptureWith(context.Background(), "https://acme.test/", Options{Mobile: true, ColorScheme: "dark"}); err != nil {
		t.Fatal(err)
	}
	if query["colorScheme"] != "dark" || query["isMobile"] != "true" || query["width"] != "390" || query["force"] != "" {
		t.Fatalf("query=%v", query)
	}
	// Capture serves deployments: it never takes the service's cached image.
	if _, err := client.Capture(context.Background(), "https://acme.test/"); err != nil || query["force"] != "true" {
		t.Fatalf("query=%v err=%v", query, err)
	}
	for raw, want := range map[string]bool{
		"https://example.com/pricing": true, "http://example.com": true,
		"ftp://example.com": false, "https://localhost:3000": false, "http://app.local": false,
		"http://127.0.0.1": false, "http://10.0.0.8": false, "http://[::1]/": false,
		"http://169.254.169.254/latest": false, "http://100.64.0.1": false, "http://8.8.8.8": true,
	} {
		if PublicPageURL(raw) != want {
			t.Errorf("PublicPageURL(%q) = %v, want %v", raw, !want, want)
		}
	}
}

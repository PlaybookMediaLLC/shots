package integrations

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

// Fetch resends only what the platform cannot have acted on: a rate limit is
// retried, then reported as rate limited; a 500 is retried for a read, but a
// server error, even one the provider calls retryable, never for a publish.
func TestFetchRetriesOnlyWhatIsSafeToResend(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	for _, test := range []struct {
		name, method, body string
		// statuses answers each request in turn; the last one repeats.
		statuses     []int
		wantRequests int
		wantType     string
	}{
		{"429 then success", http.MethodPost, "{}", []int{429, 200}, 2, ""},
		{"lasting 429", http.MethodPost, "{}", []int{429}, 4, temporalx.TypeRateLimited},
		{"rate limit text on a 400", http.MethodPost, `{"error":"Rate limit exceeded"}`, []int{400}, 4, temporalx.TypeRateLimited},
		{"500 to a read", http.MethodGet, "{}", []int{500, 200}, 2, ""},
		{"500 to a publish", http.MethodPost, "{}", []int{500}, 1, temporalx.TypeUnknownDelivery},
		{"502 to a publish", http.MethodPost, "{}", []int{502}, 1, temporalx.TypeUnknownDelivery},
		{"retryable 503 to a publish", http.MethodPost, "retry", []int{503}, 1, temporalx.TypeUnknownDelivery},
		{"retryable 503 to a read", http.MethodGet, "retry", []int{503, 200}, 2, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			var requests atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.statuses[min(int(requests.Add(1)), len(test.statuses))-1])
				_, _ = w.Write([]byte(test.body))
			}))
			defer srv.Close()
			client := NewBase("linkedin", func(body string, _ int) *HandledError {
				if body == "retry" {
					return &HandledError{Type: "retry", Value: "Service Unavailable"}
				}
				return nil
			})
			client.RetryDelay = 0
			_, err := client.Fetch(context.Background(), srv.URL, Request{Method: test.method})
			if int(requests.Load()) != test.wantRequests || temporalx.FailureType(err) != test.wantType || (err == nil) != (test.wantType == "") {
				t.Fatalf("requests=%d err=%v", requests.Load(), err)
			}
		})
	}
}

func TestMediaSizeUsesRangedGETForPresignedMedia(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	var sawRange bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Range") != "bytes=0-0" || r.URL.Query().Get("X-Amz-Signature") != "abc/def" {
			t.Errorf("unexpected size request: %s %s range=%q", r.Method, r.URL, r.Header.Get("Range"))
			w.WriteHeader(http.StatusForbidden)
			return
		}
		sawRange = true
		w.Header().Set("Content-Range", "bytes 0-0/1048586")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("x"))
	}))
	defer srv.Close()

	size, err := NewBase("x", nil).MediaSize(context.Background(), srv.URL+"/clip.mp4?X-Amz-Signature=abc%2Fdef", "x")
	if err != nil || !sawRange || size != 1048586 {
		t.Fatalf("size=%d ranged=%t error=%v", size, sawRange, err)
	}
}

func TestMediaSizeKeepsHEADForPublicMedia(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("method=%s, want HEAD", r.Method)
		}
		w.Header().Set("Content-Length", "2048")
	}))
	defer srv.Close()

	size, err := NewBase("x", nil).MediaSize(context.Background(), srv.URL+"/clip.mp4", "x")
	if err != nil || size != 2048 {
		t.Fatalf("size=%d error=%v", size, err)
	}
}

func TestBoundedMediaReadRejectsChunkedOversize(t *testing.T) {
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		_, _ = w.Write([]byte(strings.Repeat("a", 101)))
	}))
	defer srv.Close()
	client := NewBase("linkedin", nil)
	if _, err := client.ReadOrFetchBounded(context.Background(), srv.URL, 100); err == nil {
		t.Fatal("oversized stream was buffered as valid")
	}
	got, err := client.ReadOrFetchBounded(context.Background(), srv.URL, 101)
	if err != nil || len(got) != 101 {
		t.Fatalf("boundary: %d %v", len(got), err)
	}
}

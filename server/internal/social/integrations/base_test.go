package integrations

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

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

// fetchStub answers each request with the next status and counts requests.
func fetchStub(t *testing.T, header http.Header, statuses ...int) (*httptest.Server, *int) {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status := statuses[min(requests, len(statuses)-1)]
		requests++
		for key, values := range header {
			w.Header()[key] = values
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"id":"1"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &requests
}

func TestFetchNeverResendsAWriteAfterAServerError(t *testing.T) {
	srv, requests := fetchStub(t, nil, http.StatusInternalServerError, http.StatusOK)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	_, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Body: []byte(`{}`)})
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || *requests != 1 {
		t.Fatalf("err=%v requests=%d, want unknown delivery after one request", err, *requests)
	}
}

func TestFetchRetriesAReadAfterAServerError(t *testing.T) {
	srv, requests := fetchStub(t, nil, http.StatusInternalServerError, http.StatusOK)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	if _, err := b.Fetch(context.Background(), srv.URL, Request{}); err != nil || *requests != 2 {
		t.Fatalf("err=%v requests=%d, want success on the second read", err, *requests)
	}
}

func TestFetchPublishesOnceAfterARateLimitClears(t *testing.T) {
	srv, requests := fetchStub(t, nil, http.StatusTooManyRequests, http.StatusOK)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	if _, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Body: []byte(`{}`)}); err != nil || *requests != 2 {
		t.Fatalf("err=%v requests=%d, want one refused and one accepted request", err, *requests)
	}
}

func TestFetchReturnsATypedRateLimitWithRetryGuidance(t *testing.T) {
	srv, requests := fetchStub(t, http.Header{"Retry-After": {"120"}}, http.StatusTooManyRequests)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	_, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Body: []byte(`{}`)})
	if temporalx.FailureType(err) != temporalx.TypeRateLimited || *requests != 4 {
		t.Fatalf("err=%v requests=%d, want a rate limit after the short retries", err, *requests)
	}
	if after := temporalx.RetryAfter(err); after < 100*time.Second || after > 120*time.Second {
		t.Fatalf("retry after = %v, want about two minutes", after)
	}
}

func TestFetchDoesNotRetryADailyLimit(t *testing.T) {
	// A cap that also arrives as a 429 is still not worth the short retries.
	srv, requests := fetchStub(t, nil, http.StatusTooManyRequests)
	b := NewBase("stub", func(string, int) *HandledError { return &HandledError{Type: "limit", Value: "Daily cap"} })
	b.RetryDelay = time.Millisecond
	_, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Body: []byte(`{}`)})
	if temporalx.FailureType(err) != temporalx.TypeDailyLimit || temporalx.FailureMessage(err) != "Daily cap" || *requests != 1 {
		t.Fatalf("err=%v requests=%d, want a daily limit after one request", err, *requests)
	}
}

func TestFetchKeepsAReadAfterAWriteAmbiguous(t *testing.T) {
	// A permalink read after a committed comment: its limits prove nothing about the write.
	for name, handle := range map[string]ErrorHandler{
		"rate limit": nil,
		"daily cap":  func(string, int) *HandledError { return &HandledError{Type: "limit", Value: "Daily cap"} },
	} {
		srv, _ := fetchStub(t, nil, http.StatusTooManyRequests)
		b := NewBase("stub", handle)
		b.RetryDelay = time.Millisecond
		if _, err := b.Fetch(context.Background(), srv.URL, Request{}); temporalx.FailureType(err) != temporalx.TypeBadBody {
			t.Fatalf("%s on a read = %v, want an ambiguous bad body", name, err)
		}
	}
}

func TestFetchResendsARetryableWriteAfterAServerError(t *testing.T) {
	srv, requests := fetchStub(t, nil, http.StatusInternalServerError, http.StatusOK)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	if _, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Retryable: true}); err != nil || *requests != 2 {
		t.Fatalf("err=%v requests=%d, want the container created on the second request", err, *requests)
	}
}

func TestRetryAtReadsEachProviderForm(t *testing.T) {
	now := time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC)
	for name, tc := range map[string]struct {
		header http.Header
		want   time.Time
	}{
		"seconds":    {http.Header{"Retry-After": {"120"}}, now.Add(2 * time.Minute)},
		"capped":     {http.Header{"Retry-After": {"999999"}}, now.Add(24 * time.Hour)},
		"date":       {http.Header{"Retry-After": {"Wed, 11 Nov 2026 09:30:00 GMT"}}, now.Add(30 * time.Minute)},
		"x reset":    {http.Header{"X-Rate-Limit-Reset": {"1794387600"}}, time.Unix(1794387600, 0)},
		"none":       {http.Header{}, time.Time{}},
		"unreadable": {http.Header{"Retry-After": {"soon"}}, time.Time{}},
	} {
		if got := RetryAt(tc.header, now); !got.Equal(tc.want) {
			t.Fatalf("%s: got %v, want %v", name, got, tc.want)
		}
	}
}

func TestStreamedPostIsNotResentAfterAServerError(t *testing.T) {
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	for _, retryable := range []bool{false, true} {
		calls := 0
		_, err := RunStreamedUpload(context.Background(), b, retryable, func() (string, error) {
			calls++
			if calls == 1 {
				return "", &ResponseError{Status: http.StatusInternalServerError, Body: []byte("{}")}
			}
			return "ok", nil
		})
		if !retryable && (temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || calls != 1) {
			t.Fatalf("a streamed post was resent: err=%v calls=%d", err, calls)
		}
		if retryable && (err != nil || calls != 2) {
			t.Fatalf("a retryable upload was not resent: err=%v calls=%d", err, calls)
		}
	}
}

func TestFetchKeepsALimitAfterAnAmbiguousResendUnknown(t *testing.T) {
	// The first send may have committed; the limit on the resend proves nothing.
	srv, requests := fetchStub(t, nil, http.StatusInternalServerError, http.StatusTooManyRequests)
	b := NewBase("stub", nil)
	b.RetryDelay = time.Millisecond
	_, err := b.Fetch(context.Background(), srv.URL, Request{Method: http.MethodPost, Retryable: true})
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || *requests != 4 {
		t.Fatalf("err=%v requests=%d, want unknown delivery", err, *requests)
	}
}

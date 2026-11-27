package httpx

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func TestNegotiateEncoding(t *testing.T) {
	cases := map[string]string{
		"":                             "identity",
		"gzip, deflate, br":            "br",
		"gzip, deflate":                "gzip",
		"deflate":                      "deflate",
		"gzip;q=0.5, deflate":          "deflate",
		"br;q=0, gzip":                 "gzip",
		"*":                            "br",
		"identity":                     "identity",
		"gzip;q=0, deflate;q=0, *;q=0": "",
	}
	for header, want := range cases {
		var values []string
		if header != "" {
			values = []string{header}
		}
		if got := negotiateEncoding(values); got != want {
			t.Errorf("%q: got %q want %q", header, got, want)
		}
	}
}

func compressRouter() http.Handler {
	r := NewRouter()
	g := r.Group("")
	g.Get("/big", func(c *Ctx) (any, error) { return map[string]string{"data": strings.Repeat("a", 2000)}, nil })
	g.Get("/small", func(c *Ctx) (any, error) { return map[string]string{"ok": "1"}, nil })
	g.Get("/png", func(c *Ctx) (any, error) {
		c.SetHeader("Content-Type", "image/png")
		return []byte(strings.Repeat("x", 4000)), nil
	})
	return Compress(r)
}

func TestCompress(t *testing.T) {
	h := compressRouter()
	get := func(path, accept string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		if accept != "" {
			req.Header.Set("Accept-Encoding", accept)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	rec := get("/big", "gzip, deflate, br")
	if rec.Header().Get("Content-Encoding") != "br" || rec.Header().Get("Vary") != "Accept-Encoding" || rec.Header().Get("Content-Length") != "" {
		t.Fatalf("br headers: %v", rec.Header())
	}
	body, _ := io.ReadAll(brotli.NewReader(rec.Body))
	if !strings.Contains(string(body), strings.Repeat("a", 2000)) {
		t.Fatal("br body did not round-trip")
	}

	rec = get("/big", "gzip")
	zr, err := gzip.NewReader(rec.Body)
	if err != nil || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip: %v %v", err, rec.Header())
	}
	body, _ = io.ReadAll(zr)
	if !strings.HasPrefix(string(body), `{"data":"aaa`) {
		t.Fatalf("gzip body %q", body[:20])
	}

	rec = get("/small", "gzip")
	if rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("below threshold must not compress but must vary: %v", rec.Header())
	}
	if rec = get("/big", ""); rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("no Accept-Encoding must not compress")
	}
	if rec = get("/png", "gzip"); rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("Vary") != "" {
		t.Fatalf("image/png is not compressible: %v", rec.Header())
	}

	// Partial content / Content-Range responses must never be compressed so byte offsets remain intact.
	partialHandler := Compress(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Range", "bytes 0-1999/4000")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte(strings.Repeat("a", 2000)))
	}))
	req := httptest.NewRequest("GET", "/partial", nil)
	req.Header.Set("Accept-Encoding", "br, gzip")
	rec = httptest.NewRecorder()
	partialHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Header().Get("Content-Encoding") != "" || rec.Body.Len() != 2000 {
		t.Fatalf("206 must not compress: status=%d enc=%q len=%d", rec.Code, rec.Header().Get("Content-Encoding"), rec.Body.Len())
	}

	// Verify pooled writers reset cleanly across back-to-back requests.
	for range 3 {
		rec = get("/big", "br")
		body, _ := io.ReadAll(brotli.NewReader(rec.Body))
		if !strings.Contains(string(body), strings.Repeat("a", 2000)) {
			t.Fatal("pooled br writer corrupted response")
		}
	}
}

// Express's res.send: Content-Length, weak ETag, 304 on If-None-Match.
func TestExpressSendETag(t *testing.T) {
	r := NewRouter()
	r.Group("").Get("/x", func(c *Ctx) (any, error) { return map[string]int{"a": 1}, nil })
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/x", nil))
	etag := rec.Header().Get("ETag")
	if etag != `W/"7-n4nHQM60bXQYySSnisV5QdXpZSA"` || rec.Header().Get("Content-Length") != "7" {
		t.Fatalf("etag %q length %q", etag, rec.Header().Get("Content-Length"))
	}
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("If-None-Match", etag)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 304 || rec.Body.Len() != 0 || rec.Header().Get("Content-Type") != "" {
		t.Fatalf("want 304 without body, got %d %q", rec.Code, rec.Body.String())
	}
}

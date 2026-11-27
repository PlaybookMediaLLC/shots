package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

func TestAssetContentKeepsRangeAndPrivateCacheSemantics(t *testing.T) {
	for _, method := range []string{"GET", "POST"} {
		for _, scenario := range []struct {
			rangeHeader        string
			status             int
			body, contentRange string
		}{
			{"", 200, "private bytes", ""},
			{"bytes=0-6", 206, "private", "bytes 0-6/13"},
			{"bytes=99-100", 416, "invalid range", "bytes */13"},
		} {
			r := httptest.NewRequest(method, "/asset", nil)
			r.Header.Set("Range", scenario.rangeHeader)
			w := httptest.NewRecorder()
			serveAssetBytes(w, r, []byte("private bytes"), "image/png")
			if w.Code != scenario.status || !strings.Contains(w.Body.String(), scenario.body) || w.Header().Get("Content-Range") != scenario.contentRange {
				t.Fatalf("%s %q: status=%d body=%q range=%q", method, scenario.rangeHeader, w.Code, w.Body, w.Header().Get("Content-Range"))
			}
			if w.Header().Get("Cache-Control") != privateRevalidateCacheControl || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Location") != "" {
				t.Fatalf("unsafe response headers: %v", w.Header())
			}
		}
	}
}

func TestAssetStreamHandlesRangeAndNotModified(t *testing.T) {
	size := int64(7)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/asset", nil)
	serveAssetStream(w, r, &product.AssetStream{
		Body:          io.NopCloser(strings.NewReader("private")),
		MediaType:     "video/mp4",
		ETag:          `"asset-1-abc"`,
		ContentLength: &size,
		ContentRange:  "bytes 0-6/13",
		Status:        http.StatusPartialContent,
	})
	if w.Code != http.StatusPartialContent || w.Body.String() != "private" || w.Header().Get("ETag") != `"asset-1-abc"` || w.Header().Get("Content-Range") != "bytes 0-6/13" {
		t.Fatalf("unexpected range stream response: code=%d body=%q headers=%v", w.Code, w.Body.String(), w.Header())
	}

	w304 := httptest.NewRecorder()
	serveAssetStream(w304, r, &product.AssetStream{
		MediaType: "image/png",
		ETag:      `"asset-1-abc"`,
		Status:    http.StatusNotModified,
	})
	if w304.Code != http.StatusNotModified || w304.Body.Len() != 0 || w304.Header().Get("ETag") != `"asset-1-abc"` || w304.Header().Get("Cache-Control") != privateRevalidateCacheControl {
		t.Fatalf("unexpected 304 response: code=%d body=%q headers=%v", w304.Code, w304.Body.String(), w304.Header())
	}
}

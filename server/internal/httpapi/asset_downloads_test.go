package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/google/uuid"
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

type batchAssetFake struct {
	fakeConfiguration
	seen []string
	err  error
}

func (f *batchAssetFake) SignAssetDownloads(_ context.Context, _ product.Actor, assetIDs []string) (map[string]string, error) {
	f.seen = append([]string(nil), assetIDs...)
	if f.err != nil {
		return nil, f.err
	}
	out := make(map[string]string, len(assetIDs))
	for _, id := range assetIDs {
		out[id] = "https://shots.example/api/v1/assets/" + id + "/content?downloadToken=tok"
	}
	return out, nil
}

func TestSignAssetDownloadsEndpoint(t *testing.T) {
	cfg := &batchAssetFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", cfg)

	id1 := uuid.NewString()
	id2 := uuid.NewString()
	res := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", fmt.Sprintf(`{"assetIds":[%q,%q]}`, id1, id2))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		URLs map[string]string `json:"urls"`
	}
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.URLs) != 2 || payload.URLs[id1] == "" || payload.URLs[id2] == "" {
		t.Fatalf("unexpected urls: %+v", payload.URLs)
	}
	if len(cfg.seen) != 2 || cfg.seen[0] != id1 || cfg.seen[1] != id2 {
		t.Fatalf("unexpected seen ids: %+v", cfg.seen)
	}

	// Empty list returns empty map.
	emptyRes := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", `{"assetIds":[]}`)
	if emptyRes.Code != http.StatusOK || len(cfg.seen) != 0 {
		t.Fatalf("empty status=%d seen=%+v", emptyRes.Code, cfg.seen)
	}

	// Malformed JSON and invalid UUIDs return 400.
	if badJSON := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", `{bad`); badJSON.Code != http.StatusBadRequest {
		t.Fatalf("malformed json status=%d, want 400", badJSON.Code)
	}
	if badUUID := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", `{"assetIds":["not-a-uuid"]}`); badUUID.Code != http.StatusBadRequest {
		t.Fatalf("invalid uuid status=%d, want 400", badUUID.Code)
	}

	// Rejects >100 IDs.
	tooMany := make([]string, 101)
	for i := range tooMany {
		tooMany[i] = uuid.NewString()
	}
	encoded, _ := json.Marshal(map[string]any{"assetIds": tooMany})
	over := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", string(encoded))
	if over.Code != http.StatusBadRequest {
		t.Fatalf("over limit status=%d, want 400", over.Code)
	}

	// Store error propagates cleanly.
	cfg.err = product.ErrStorageUnavailable
	errRes := configurationRequest(handler, http.MethodPost, "/v1/assets/sign-downloads", fmt.Sprintf(`{"assetIds":[%q]}`, id1))
	if errRes.Code != http.StatusServiceUnavailable {
		t.Fatalf("store error status=%d, want 503", errRes.Code)
	}
}

package httpapi

import (
	"encoding/base64"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// registerScreenshots exposes the global screenshot cache to the web facade.
// It is not tenant data and the public capture route has no principal, so
// only the service token authenticates these routes.
func (s *Server) registerScreenshots(mux *http.ServeMux) {
	mux.Handle("GET /v1/internal/screenshot-cache/{hash}", s.authenticateService(http.HandlerFunc(s.getScreenshotCache)))
	mux.Handle("GET /v1/internal/screenshot-cache/{hash}/object", s.authenticateService(http.HandlerFunc(s.getScreenshotCacheObject)))
	mux.Handle("PUT /v1/internal/screenshot-cache/{hash}/object", s.authenticateService(http.HandlerFunc(s.putScreenshotCacheObject)))
	mux.Handle("PUT /v1/internal/screenshot-cache/{hash}", s.authenticateService(http.HandlerFunc(s.putScreenshotCache)))
	mux.Handle("DELETE /v1/internal/screenshot-cache/{hash}", s.authenticateService(http.HandlerFunc(s.deleteScreenshotCache)))
	mux.Handle("POST /v1/internal/screenshot-cache/query", s.authenticateService(http.HandlerFunc(s.listScreenshotCache)))
	mux.Handle("POST /v1/internal/screenshot-cache/purge", s.authenticateService(http.HandlerFunc(s.purgeScreenshotCache)))
}

func (s *Server) getScreenshotCacheObject(w http.ResponseWriter, r *http.Request) {
	body, err := s.configuration.GetScreenshotCacheObject(r.Context(), r.PathValue("hash"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if strings.Contains(r.Header.Get("Accept"), "image/png") {
		mediaType := "image/png"
		if len(body) >= 2 && body[0] == 0xff && body[1] == 0xd8 {
			mediaType = "image/jpeg"
		}
		w.Header().Set("Content-Type", mediaType)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"base64": base64.StdEncoding.EncodeToString(body)})
}

func (s *Server) putScreenshotCacheObject(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Content-Type") != "image/png" {
		writeError(w, http.StatusBadRequest, "screenshot must be a PNG")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "screenshot exceeds 10 MiB")
		return
	}
	if err := s.configuration.PutScreenshotCacheObject(r.Context(), r.PathValue("hash"), body); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"stored": true})
}

func (s *Server) getScreenshotCache(w http.ResponseWriter, r *http.Request) {
	entry, err := s.configuration.GetScreenshotCache(r.Context(), r.PathValue("hash"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) putScreenshotCache(w http.ResponseWriter, r *http.Request) {
	var input product.ScreenshotCacheInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid screenshot cache entry")
		return
	}
	entry, err := s.configuration.PutScreenshotCache(r.Context(), r.PathValue("hash"), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) deleteScreenshotCache(w http.ResponseWriter, r *http.Request) {
	if err := s.configuration.DeleteScreenshotCache(r.Context(), r.PathValue("hash")); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) listScreenshotCache(w http.ResponseWriter, r *http.Request) {
	var filter product.ScreenshotCacheFilter
	if err := decodeJSON(r, &filter); err != nil {
		writeError(w, http.StatusBadRequest, "invalid screenshot cache filter")
		return
	}
	entries, err := s.configuration.ListScreenshotCache(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) purgeScreenshotCache(w http.ResponseWriter, r *http.Request) {
	var filter product.ScreenshotCacheFilter
	if err := decodeJSON(r, &filter); err != nil {
		writeError(w, http.StatusBadRequest, "invalid screenshot cache filter")
		return
	}
	deleted, err := s.configuration.PurgeScreenshotCache(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"deleted": deleted})
}

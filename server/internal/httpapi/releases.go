package httpapi

import (
	"net/http"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

func (s *Server) listReleases(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if r.URL.Query().Has("limit") {
		parsed, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid release limit")
			return
		}
		limit = parsed
	}
	if limit < 1 || limit > 100 {
		writeError(w, http.StatusBadRequest, "invalid release limit")
		return
	}
	items, err := s.configuration.ListReleases(r.Context(), workspaceActor(r), limit, r.URL.Query().Get("search"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"releases": items})
}

func (s *Server) getRelease(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid release ID")
		return
	}
	item, err := s.configuration.GetRelease(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) createRelease(w http.ResponseWriter, r *http.Request) {
	var input product.CreateReleaseInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid release request")
		return
	}
	if input.SourceURLs == nil {
		input.SourceURLs = []string{}
	}
	result, err := s.configuration.CreateRelease(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

func (s *Server) updateRelease(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid release ID")
		return
	}
	var input product.UpdateReleaseInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid release request")
		return
	}
	item, err := s.configuration.UpdateRelease(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

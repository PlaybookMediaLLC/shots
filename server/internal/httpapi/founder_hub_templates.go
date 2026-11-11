package httpapi

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"net/http"
)

func (s *Server) listFounderHubTemplates(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.ListFounderHubTemplates(r.Context(), workspaceActor(r), r.URL.Query().Get("cursor"), r.URL.Query().Get("includeDeleted") == "true", r.URL.Query().Get("revision"))
	respond(w, http.StatusOK, result, err)
}

func (s *Server) updateFounderHubTemplate(w http.ResponseWriter, r *http.Request) {
	var input product.FounderHubTemplateUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid Founder Hub template")
		return
	}
	input.Native = r.Header.Get("X-Shots-Founder-Hub-Native") == "true"
	result, err := s.configuration.UpdateFounderHubTemplate(r.Context(), workspaceActor(r), r.PathValue("id"), input)
	respond(w, http.StatusOK, result, err)
}

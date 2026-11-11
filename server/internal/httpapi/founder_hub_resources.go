package httpapi

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"net/http"
)

func (s *Server) founderHubResourceAction(w http.ResponseWriter, r *http.Request) {
	var input product.FounderHubResourceAction
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid shared resource request")
		return
	}
	result, err := s.configuration.FounderHubResourceAction(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, result, err)
}

func (s *Server) founderHubShareWorkspaces(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.FounderHubShareWorkspaces(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, result, err)
}

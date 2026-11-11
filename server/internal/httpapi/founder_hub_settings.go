package httpapi

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"net/http"
)

func (s *Server) listFounderHubSettings(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListFounderHubSettings(r.Context(), workspaceActor(r))
	if err != nil {
		respond[any](w, http.StatusOK, nil, err)
		return
	}
	account, err := s.configuration.GetFounderHubSettingsAccount(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, map[string]any{"catalog": founderhub.Catalog, "profiles": items, "account": account}, err)
}

func (s *Server) updateFounderHubSettings(w http.ResponseWriter, r *http.Request) {
	var input product.FounderHubSettingsUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid Founder Hub settings")
		return
	}
	input.Native = r.Header.Get("X-Shots-Founder-Hub-Native") == "true"
	result, err := s.configuration.UpdateFounderHubSettings(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, result, err)
}

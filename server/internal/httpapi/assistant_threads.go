package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// Saved assistant threads, private to the signed-in person.
func (s *Server) registerAssistantThreads(mux *http.ServeMux) {
	handle := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, s.authenticateProduct(handler))
	}
	handle("GET /v1/assistant-threads", s.listAssistantThreads)
	handle("GET /v1/assistant-threads/{id}", s.getAssistantThread)
	handle("PUT /v1/assistant-threads/{id}", s.saveAssistantThread)
	handle("DELETE /v1/assistant-threads/{id}", s.deleteAssistantThread)
}

func (s *Server) listAssistantThreads(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListAssistantThreads(r.Context(), workspaceActor(r))
	writeLaunch(w, http.StatusOK, map[string]any{"threads": items}, err)
}

func (s *Server) getAssistantThread(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetAssistantThread(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) saveAssistantThread(w http.ResponseWriter, r *http.Request) {
	id, ok := launchID(w, r, "id")
	if !ok {
		return
	}
	var input product.SaveAssistantThreadInput
	if !launchBody(w, r, &input) {
		return
	}
	result, err := s.configuration.SaveAssistantThread(r.Context(), workspaceActor(r), id, input)
	writeLaunch(w, http.StatusOK, result, err)
}

func (s *Server) deleteAssistantThread(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		err := s.configuration.DeleteAssistantThread(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"deleted": true}, err)
	}
}

package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// Conversations (docs/rfcs/028-conversational-campaign-creation.md). Roles
// are checked per operation in the product layer.
func (s *Server) registerConversations(mux *http.ServeMux) {
	handle := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, s.authenticateProduct(handler))
	}
	handle("GET /v1/conversations", s.listConversations)
	handle("POST /v1/conversations", s.createConversation)
	handle("GET /v1/conversations/{id}", s.getConversation)
	handle("GET /v1/conversations/{id}/view", s.getConversationView)
	handle("PATCH /v1/conversations/{id}", s.updateConversation)
	handle("POST /v1/conversations/{id}/messages", s.appendConversationMessage)
}

func (s *Server) listConversations(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryLimit(r, 20, 100)
	input := product.ListConversationsInput{Limit: limit, Status: r.URL.Query().Get("status")}
	if campaignID := r.URL.Query().Get("campaignId"); campaignID != "" {
		ok = ok && resourceIDPattern.MatchString(campaignID)
		input.CampaignID = &campaignID
	}
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid conversation filter")
		return
	}
	items, err := s.configuration.ListConversations(r.Context(), workspaceActor(r), input)
	writeLaunch(w, http.StatusOK, map[string]any{"conversations": items}, err)
}

func (s *Server) createConversation(w http.ResponseWriter, r *http.Request) {
	var input product.CreateConversationInput
	if !launchBody(w, r, &input) {
		return
	}
	if input.CampaignID != nil && !resourceIDPattern.MatchString(*input.CampaignID) {
		writeError(w, http.StatusBadRequest, "invalid campaignId")
		return
	}
	result, err := s.configuration.CreateConversation(r.Context(), workspaceActor(r), input)
	writeLaunch(w, http.StatusCreated, result, err)
}

func (s *Server) getConversation(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetConversation(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) getConversationView(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetConversationView(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) updateConversation(w http.ResponseWriter, r *http.Request) {
	var input product.UpdateConversationInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		if input.CampaignID.Value != nil && !resourceIDPattern.MatchString(*input.CampaignID.Value) {
			writeError(w, http.StatusBadRequest, "invalid campaignId")
			return
		}
		result, err := s.configuration.UpdateConversation(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) appendConversationMessage(w http.ResponseWriter, r *http.Request) {
	var input product.AppendConversationMessageInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		if input.LaunchRunID != nil && !resourceIDPattern.MatchString(*input.LaunchRunID) {
			writeError(w, http.StatusBadRequest, "invalid launchRunId")
			return
		}
		result, err := s.configuration.AppendConversationMessage(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

package httpapi

import (
	"net/http"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

func (s *Server) listCampaigns(w http.ResponseWriter, r *http.Request) {
	var filters []product.CampaignListFilter
	query := r.URL.Query()
	if query.Has("limit") || query.Has("cursor") || query.Has("releaseId") || query.Has("idempotencyKey") || query.Has("search") || query.Has("sort") {
		limit, err := strconv.Atoi(query.Get("limit"))
		if err != nil || limit < 1 || limit > 100 || len(query.Get("idempotencyKey")) > 128 ||
			(query.Get("cursor") != "" && !resourceIDPattern.MatchString(query.Get("cursor"))) ||
			(query.Get("releaseId") != "" && !resourceIDPattern.MatchString(query.Get("releaseId"))) {
			writeError(w, http.StatusBadRequest, "invalid campaign query")
			return
		}
		filters = append(filters, product.CampaignListFilter{Limit: limit, Cursor: query.Get("cursor"), ReleaseID: query.Get("releaseId"), IdempotencyKey: query.Get("idempotencyKey"), Search: query.Get("search"), Sort: query.Get("sort")})
	}
	items, err := s.configuration.ListCampaigns(r.Context(), workspaceActor(r), filters...)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"campaigns": items})
}

func (s *Server) getCampaign(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	item, err := s.configuration.GetCampaign(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) createCampaign(w http.ResponseWriter, r *http.Request) {
	var input product.CreateCampaignInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign request")
		return
	}
	item, err := s.configuration.CreateCampaign(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) transitionCampaign(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	var input struct {
		Status string `json:"status"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign transition")
		return
	}
	result, err := s.configuration.TransitionCampaign(r.Context(), workspaceActor(r), id, input.Status)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// listApprovals is the review queue: posts waiting for a reviewer, oldest first.
func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request) {
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if r.URL.Query().Get("limit") == "" {
		limit, err = 50, nil
	}
	cursor := r.URL.Query().Get("cursor")
	if err != nil || (cursor != "" && !resourceIDPattern.MatchString(cursor)) {
		writeError(w, http.StatusBadRequest, "invalid approval query")
		return
	}
	page, err := s.configuration.ListPendingApprovals(r.Context(), workspaceActor(r), limit, cursor)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) decideCampaignPosts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	var input product.CampaignPostDecision
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign post decision")
		return
	}
	result, err := s.configuration.TransitionCampaignPosts(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// submitCampaignPosts moves draft posts to review. It is the one transition an
// API key or service may make; the decisions stay on the decide route.
func (s *Server) submitCampaignPosts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	var input struct {
		PostIDs []string `json:"postIds"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign post submission")
		return
	}
	result, err := s.configuration.TransitionCampaignPosts(r.Context(), workspaceActor(r), id,
		product.CampaignPostDecision{Decision: "submit", PostIDs: input.PostIDs})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) updateCampaignPost(w http.ResponseWriter, r *http.Request) {
	campaignID, postID := r.PathValue("id"), r.PathValue("postId")
	if !resourceIDPattern.MatchString(campaignID) || !resourceIDPattern.MatchString(postID) {
		writeError(w, http.StatusBadRequest, "invalid campaign or post ID")
		return
	}
	var input product.UpdateCampaignPostInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign post edit")
		return
	}
	post, err := s.configuration.UpdateCampaignPost(r.Context(), workspaceActor(r), campaignID, postID, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, post)
}

func (s *Server) scheduleCampaignPost(w http.ResponseWriter, r *http.Request) {
	campaignID, postID := r.PathValue("id"), r.PathValue("postId")
	if !resourceIDPattern.MatchString(campaignID) || !resourceIDPattern.MatchString(postID) {
		writeError(w, http.StatusBadRequest, "invalid campaign or post ID")
		return
	}
	var input product.ScheduleCampaignPostInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign schedule")
		return
	}
	result, err := s.configuration.ScheduleCampaignPost(r.Context(), workspaceActor(r), campaignID, postID, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if result.ScheduledPost.Status == scheduledpost.StatusSCHEDULED {
		if err := s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{
			OrganizationID: result.ScheduledPost.OrganizationID,
			PostID:         result.ScheduledPost.ID,
			ScheduledFor:   result.ScheduledPost.ScheduledFor,
		}); err != nil {
			writeError(w, http.StatusServiceUnavailable, "could not start publishing workflow")
			return
		}
	}
	writeJSON(w, http.StatusOK, result.Post)
}

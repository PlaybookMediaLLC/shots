package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/google/uuid"
)

// The campaign studio: campaign asset links, generated copy, and in-place
// design edits. Roles are checked per operation in the product layer.
func (s *Server) registerCampaignAssets(mux *http.ServeMux) {
	handle := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, s.authenticateProduct(handler))
	}
	handle("GET /v1/campaigns/{id}/assets/{assetId}", s.getCampaignAsset)
	handle("PUT /v1/campaigns/{id}/assets/{assetId}", s.linkCampaignAsset)
	handle("POST /v1/campaigns/{id}/copy", s.saveCampaignCopy)
	handle("POST /v1/campaigns/{id}/publish-drafts", s.createCampaignPublishDraft)
	handle("PUT /v1/designs/{id}", s.replaceDesign)
	handle("POST /v1/campaigns/{id}/designs/{designId}/approval", s.approveCampaignDesign)
	handle("POST /v1/campaigns/{id}/assets/{assetId}/approval", s.approveCampaignAsset)
}

// campaignAssetPath reads the campaign and asset IDs, answering 400 when malformed.
func campaignAssetPath(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	campaignID, assetID := r.PathValue("id"), r.PathValue("assetId")
	if !resourceIDPattern.MatchString(campaignID) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return "", "", false
	}
	if _, err := uuid.Parse(assetID); err != nil {
		writeError(w, http.StatusBadRequest, "invalid asset ID")
		return "", "", false
	}
	return campaignID, assetID, true
}

func (s *Server) getCampaignAsset(w http.ResponseWriter, r *http.Request) {
	campaignID, assetID, ok := campaignAssetPath(w, r)
	if !ok {
		return
	}
	link, err := s.configuration.GetCampaignAsset(r.Context(), workspaceActor(r), campaignID, assetID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, link)
}

func (s *Server) linkCampaignAsset(w http.ResponseWriter, r *http.Request) {
	campaignID, assetID, ok := campaignAssetPath(w, r)
	if !ok {
		return
	}
	var input product.LinkCampaignAssetInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign asset")
		return
	}
	link, err := s.configuration.LinkCampaignAsset(r.Context(), workspaceActor(r), campaignID, assetID, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, link)
}

func (s *Server) saveCampaignCopy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	var input product.SaveCampaignCopyInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid campaign copy")
		return
	}
	if err := s.configuration.SaveCampaignCopy(r.Context(), workspaceActor(r), id, input); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"angleCount": len(input.Angles), "postCount": len(input.Posts)})
}

// createCampaignPublishDraft turns an edited campaign visual into a Publish
// draft, attaching the export to the campaign in the same transaction.
func (s *Server) createCampaignPublishDraft(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid campaign ID")
		return
	}
	var input product.CampaignPublishDraftInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid publish draft")
		return
	}
	draft, err := s.configuration.CreateCampaignPublishDraft(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, draft)
}

func (s *Server) replaceDesign(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid design ID")
		return
	}
	var input product.ReplaceDesignInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid design")
		return
	}
	if err := s.configuration.ReplaceDesign(r.Context(), workspaceActor(r), id, input); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"updated": true})
}

func (s *Server) approveCampaignDesign(w http.ResponseWriter, r *http.Request) {
	campaignID, designID := r.PathValue("id"), r.PathValue("designId")
	if !resourceIDPattern.MatchString(campaignID) || !resourceIDPattern.MatchString(designID) {
		writeError(w, http.StatusBadRequest, "invalid campaign or design ID")
		return
	}
	result, err := s.configuration.ApproveCampaignDesign(r.Context(), workspaceActor(r), campaignID, designID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) approveCampaignAsset(w http.ResponseWriter, r *http.Request) {
	campaignID, assetID, ok := campaignAssetPath(w, r)
	if !ok {
		return
	}
	result, err := s.configuration.ApproveCampaignAsset(r.Context(), workspaceActor(r), campaignID, assetID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

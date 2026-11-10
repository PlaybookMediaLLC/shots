package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

var workspaceSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var publishTimePattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)
var localePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$`)

func (s *Server) registerWorkspace(mux *http.ServeMux) {
	mux.Handle("GET /v1/founder-hub/settings", s.authenticateSession(http.HandlerFunc(s.listFounderHubSettings)))
	mux.Handle("GET /v1/founder-hub/templates", s.authenticateSession(http.HandlerFunc(s.listFounderHubTemplates)))
	mux.Handle("POST /v1/founder-hub/resources", s.authenticateSession(http.HandlerFunc(s.founderHubResourceAction)))
	mux.Handle("GET /v1/founder-hub/resources/workspaces", s.authenticateSession(http.HandlerFunc(s.founderHubShareWorkspaces)))
	mux.Handle("PATCH /v1/founder-hub/templates/{id}", s.authenticateSession(http.HandlerFunc(s.updateFounderHubTemplate)))
	mux.Handle("PATCH /v1/founder-hub/settings", s.authenticateSession(http.HandlerFunc(s.updateFounderHubSettings)))
	mux.Handle("GET /v1/founder-hub/devices", s.authenticateSession(http.HandlerFunc(s.listFounderHubDevices)))
	mux.Handle("POST /v1/founder-hub/devices/report", s.authenticateSession(http.HandlerFunc(s.reportFounderHubDevice)))
	mux.Handle("POST /v1/founder-hub/devices/commands", s.authenticateSession(http.HandlerFunc(s.createFounderHubDeviceCommand)))
	mux.Handle("GET /v1/founder-hub/devices/commands/{id}", s.authenticateSession(http.HandlerFunc(s.getFounderHubDeviceCommand)))
	mux.Handle("PATCH /v1/founder-hub/devices/commands/{id}", s.authenticateSession(http.HandlerFunc(s.finishFounderHubDeviceCommand)))
	mux.Handle("GET /v1/founder-hub/session", s.authenticateSession(http.HandlerFunc(s.founderHubSession)))
	mux.Handle("GET /v1/founder-hub/authorization", s.authenticateSession(http.HandlerFunc(s.founderHubAuthorization)))
	mux.Handle("GET /v1/founder-hub/key-session", s.authenticateSession(http.HandlerFunc(s.founderHubKeySession)))
	mux.Handle("GET /v1/founder-hub/connector-session", s.authenticateSession(http.HandlerFunc(s.founderHubConnectorSession)))
	mux.Handle("DELETE /v1/founder-hub/session", s.authenticateSession(http.HandlerFunc(s.revokeFounderHubSession)))
	mux.Handle("GET /v1/invitations/{id}", s.authenticateSession(http.HandlerFunc(s.getRecipientInvitation)))
	mux.Handle("POST /v1/invitations/{id}/respond", s.authenticateSession(http.HandlerFunc(s.respondInvitation)))
	mux.Handle("GET /v1/workspaces", s.authenticateSession(http.HandlerFunc(s.listWorkspaces)))
	mux.Handle("POST /v1/workspaces", s.authenticateSession(http.HandlerFunc(s.createWorkspace)))
	mux.Handle("POST /v1/workspaces/active", s.authenticateSession(http.HandlerFunc(s.setActiveWorkspace)))
	mux.Handle("GET /v1/workspace", s.authenticateProduct(http.HandlerFunc(s.getWorkspace)))
	mux.Handle("PATCH /v1/workspace", s.authenticateProduct(http.HandlerFunc(s.updateWorkspace)))
	mux.Handle("GET /v1/workspace/members", s.authenticateProduct(http.HandlerFunc(s.listWorkspaceMembers)))
	mux.Handle("GET /v1/workspace/invitations", s.authenticateProduct(http.HandlerFunc(s.listWorkspaceInvitations)))
	mux.Handle("POST /v1/workspace/invitations", s.authenticateProduct(http.HandlerFunc(s.inviteWorkspaceMember)))
	mux.Handle("POST /v1/workspace/invitations/{id}/resend", s.authenticateProduct(http.HandlerFunc(s.resendWorkspaceInvitation)))
	mux.Handle("DELETE /v1/workspace/invitations/{id}", s.authenticateProduct(http.HandlerFunc(s.revokeWorkspaceInvitation)))
	mux.Handle("PATCH /v1/workspace/members/{id}", s.authenticateProduct(http.HandlerFunc(s.updateWorkspaceMemberRole)))
	mux.Handle("DELETE /v1/workspace/members/{id}", s.authenticateProduct(http.HandlerFunc(s.removeWorkspaceMember)))
	mux.Handle("POST /v1/workspace/leave", s.authenticateProduct(http.HandlerFunc(s.leaveWorkspace)))
	mux.Handle("POST /v1/workspace/transfer-ownership", s.authenticateProduct(http.HandlerFunc(s.transferWorkspaceOwnership)))
	mux.Handle("POST /v1/workspace/deletion", s.authenticateProduct(http.HandlerFunc(s.requestWorkspaceDeletion)))
	mux.Handle("POST /v1/workspaces/deletion/cancel", s.authenticateSession(http.HandlerFunc(s.cancelWorkspaceDeletion)))
	mux.Handle("GET /v1/bootstrap", s.authenticateProduct(http.HandlerFunc(s.bootstrap)))
	mux.Handle("GET /v1/me", s.authenticateSession(http.HandlerFunc(s.currentUser)))
	mux.Handle("GET /v1/page-access", s.authenticateSession(http.HandlerFunc(s.pageAccess)))
	// GetActiveAccess authorizes the session itself before anything else.
	mux.Handle("GET /v1/access", s.authenticateWithOptions(http.HandlerFunc(s.activeAccess), false, true,
		func(context.Context, product.Actor) error { return nil }))
	mux.Handle("GET /v1/support-grants/verify", s.authenticateSession(http.HandlerFunc(s.verifySupportGrant)))
	mux.Handle("GET /v1/enterprise-features/{feature}", s.authenticateProduct(http.HandlerFunc(s.enterpriseFeature)))
	mux.Handle("GET /v1/assets", s.authenticateProduct(http.HandlerFunc(s.listAssets)))
	mux.Handle("POST /v1/quotas/consume", s.authenticateProduct(http.HandlerFunc(s.consumeWorkspaceQuota)))
	mux.Handle("GET /v1/releases", s.authenticateProduct(http.HandlerFunc(s.listReleases)))
	mux.Handle("POST /v1/releases", s.authenticateProduct(http.HandlerFunc(s.createRelease)))
	mux.Handle("GET /v1/releases/{id}", s.authenticateProduct(http.HandlerFunc(s.getRelease)))
	mux.Handle("PATCH /v1/releases/{id}", s.authenticateProduct(http.HandlerFunc(s.updateRelease)))
	mux.Handle("GET /v1/campaigns", s.authenticateProduct(http.HandlerFunc(s.listCampaigns)))
	mux.Handle("POST /v1/campaigns", s.authenticateProduct(http.HandlerFunc(s.createCampaign)))
	mux.Handle("GET /v1/campaigns/{id}", s.authenticateProduct(http.HandlerFunc(s.getCampaign)))
	mux.Handle("POST /v1/campaigns/{id}/transition", s.authenticateProduct(http.HandlerFunc(s.transitionCampaign)))
	mux.Handle("POST /v1/campaigns/{id}/posts/decide", s.authenticateProduct(http.HandlerFunc(s.decideCampaignPosts)))
	mux.Handle("PATCH /v1/campaigns/{id}/posts/{postId}", s.authenticateProduct(http.HandlerFunc(s.updateCampaignPost)))
	mux.Handle("POST /v1/campaigns/{id}/posts/submit", s.authenticateProduct(http.HandlerFunc(s.submitCampaignPosts)))
	mux.Handle("POST /v1/campaigns/{id}/posts/{postId}/schedule", s.authenticateProduct(http.HandlerFunc(s.scheduleCampaignPost)))
	mux.Handle("GET /v1/campaigns/{id}/designs", s.authenticateProduct(http.HandlerFunc(s.listCampaignDesigns)))
	mux.Handle("GET /v1/approvals", s.authenticateProduct(http.HandlerFunc(s.listApprovals)))
	mux.Handle("POST /v1/designs", s.authenticateProduct(http.HandlerFunc(s.createDesign)))
	mux.Handle("GET /v1/designs/{id}", s.authenticateProduct(http.HandlerFunc(s.getDesign)))
	mux.Handle("PUT /v1/designs/{id}/document", s.authenticateProduct(http.HandlerFunc(s.updateDesignDocument)))
	mux.Handle("PUT /v1/designs/{id}/render", s.authenticateProduct(http.HandlerFunc(s.setDesignRender)))
	mux.Handle("GET /v1/entitlements", s.authenticateProduct(http.HandlerFunc(s.getEntitlements)))
	mux.Handle("GET /v1/entitlements/features/{feature}", s.authenticateProduct(http.HandlerFunc(s.getFeatureDecision)))
	mux.Handle("GET /v1/creative-templates", s.authenticateProduct(http.HandlerFunc(s.listCreativeTemplates)))
	mux.Handle("POST /v1/creative-templates", s.authenticateProduct(http.HandlerFunc(s.createCreativeTemplate)))
	mux.Handle("POST /v1/creative-variants", s.authenticateProduct(http.HandlerFunc(s.createCreativeVariant)))
	mux.Handle("POST /v1/creative-variants/{id}/decision", s.authenticateProduct(http.HandlerFunc(s.decideCreativeVariant)))
	mux.Handle("POST /v1/assets/upload-url", s.authenticateProduct(http.HandlerFunc(s.signAssetUpload)))
	mux.Handle("POST /v1/assets/generated", s.authenticateProduct(http.HandlerFunc(s.storeGeneratedAsset)))
	mux.Handle("POST /v1/assets/{id}/complete", s.authenticateProduct(http.HandlerFunc(s.completeAssetUpload)))
	mux.Handle("POST /v1/assets/{id}/upload-parts", s.authenticateProduct(http.HandlerFunc(s.signAssetUploadParts)))
	mux.Handle("GET /v1/assets/{id}/download-url", s.authenticateProduct(http.HandlerFunc(s.signAssetDownload)))
	mux.Handle("GET /v1/assets/{id}/bytes", s.authenticateProduct(http.HandlerFunc(s.readAsset)))
	mux.Handle("POST /v1/internal/assets/{id}/download", s.authenticateService(http.HandlerFunc(s.readAssetDownload)))
	mux.Handle("DELETE /v1/assets/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteAsset)))
	mux.Handle("GET /v1/audit-logs", s.authenticateProduct(http.HandlerFunc(s.listAuditLogs)))
}

func (s *Server) founderHubSession(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetFounderHubSession(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) founderHubAuthorization(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.AuthorizeFounderHubSession(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, result, err)
}

func (s *Server) founderHubKeySession(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetFounderHubKeySession(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) founderHubConnectorSession(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetFounderHubConnectorSession(r.Context(), workspaceActor(r), r.URL.Query().Get("clientId"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) revokeFounderHubSession(w http.ResponseWriter, r *http.Request) {
	if err := s.configuration.RevokeFounderHubSession(r.Context(), workspaceActor(r)); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func (s *Server) currentUser(w http.ResponseWriter, r *http.Request) {
	person, err := s.configuration.GetCurrentUser(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": person})
}

func (s *Server) activeAccess(w http.ResponseWriter, r *http.Request) {
	access, err := s.configuration.GetActiveAccess(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, access)
}

func (s *Server) bootstrap(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.Bootstrap(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) inviteWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if decodeJSON(r, &input) != nil || !product.ValidAssignableRole(input.Role) {
		writeError(w, http.StatusBadRequest, "valid email and role are required")
		return
	}
	created, err := s.configuration.InviteMember(r.Context(), actor, input.Email, input.Role)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) resendWorkspaceInvitation(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if id == "" || len(id) > 128 {
		writeError(w, http.StatusBadRequest, "valid invitation ID is required")
		return
	}
	updated, err := s.configuration.ResendInvitation(r.Context(), actor, id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) revokeWorkspaceInvitation(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if id == "" || len(id) > 128 {
		writeError(w, http.StatusBadRequest, "valid invitation ID is required")
		return
	}
	result, err := s.configuration.CancelInvitation(r.Context(), actor, id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) requestWorkspaceDeletion(w http.ResponseWriter, r *http.Request) {
	actor := workspaceActor(r)
	if err := s.configuration.AuthorizeSensitive(r.Context(), actor); err != nil {
		writeStoreError(w, err)
		return
	}
	var input struct {
		Confirmation string `json:"confirmation"`
	}
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Confirmation = strings.TrimSpace(input.Confirmation)
	if utf8.RuneCountInString(input.Confirmation) < 2 || utf8.RuneCountInString(input.Confirmation) > 100 {
		writeError(w, http.StatusBadRequest, "confirmation is required")
		return
	}
	deletion, err := s.configuration.RequestDeletion(r.Context(), actor, input.Confirmation)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// A running onboarding run stops now; the purge deletes its pages later.
	if s.onboarding != nil {
		if err := s.onboarding.CancelWorkspace(r.Context(), actor.OrganizationID); err != nil {
			slog.Error("onboarding run not cancelled for workspace deletion", "organizationId", actor.OrganizationID, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, workspaceDeletionResponse(deletion))
}

func (s *Server) cancelWorkspaceDeletion(w http.ResponseWriter, r *http.Request) {
	deletion, err := s.configuration.CancelDeletion(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workspaceDeletionResponse(deletion))
}

func workspaceDeletionResponse(value *ent.WorkspaceDeletion) map[string]any {
	return map[string]any{
		"id": value.ID, "organizationId": value.OrganizationID,
		"requestedByUserId": value.RequestedByUserID, "status": value.Status,
		"scheduledFor": value.ScheduledFor, "cancelledAt": value.CancelledAt,
		"processingAt": value.ProcessingAt, "purgedAt": value.PurgedAt,
		"lastError": value.LastError, "createdAt": value.CreatedAt, "updatedAt": value.UpdatedAt,
	}
}

func (s *Server) updateWorkspaceMemberRole(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	memberID := r.PathValue("id")
	var input struct {
		Role string `json:"role"`
	}
	if memberID == "" || len(memberID) > 128 || decodeJSON(r, &input) != nil || !product.ValidAssignableRole(input.Role) {
		writeError(w, http.StatusBadRequest, "valid member ID and role are required")
		return
	}
	changed, err := s.configuration.UpdateMemberRole(r.Context(), actor, memberID, input.Role)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, changed)
}

func (s *Server) removeWorkspaceMember(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	memberID := r.PathValue("id")
	if memberID == "" || len(memberID) > 128 {
		writeError(w, http.StatusBadRequest, "valid member ID is required")
		return
	}
	removed, err := s.configuration.RemoveMember(r.Context(), actor, memberID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": true, "member": removed})
}

func (s *Server) leaveWorkspace(w http.ResponseWriter, r *http.Request) {
	left, err := s.configuration.LeaveWorkspace(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"left": true, "member": left})
}

func (s *Server) transferWorkspaceOwnership(w http.ResponseWriter, r *http.Request) {
	actor := workspaceActor(r)
	if err := s.configuration.AuthorizeSensitive(r.Context(), actor); err != nil {
		writeStoreError(w, err)
		return
	}
	var input struct {
		MemberID string `json:"memberId"`
	}
	if decodeJSON(r, &input) != nil || input.MemberID == "" || len(input.MemberID) > 128 {
		writeError(w, http.StatusBadRequest, "memberId is required")
		return
	}
	if err := s.configuration.TransferOwnership(r.Context(), actor, input.MemberID); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"transferred": true})
}

func (s *Server) listWorkspaceMembers(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListMembers(r.Context(), r.Header.Get("X-Organization-ID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": items})
}

func (s *Server) listWorkspaceInvitations(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.configurationActor(w, r); !ok {
		return
	}
	items, err := s.configuration.ListInvitations(r.Context(), r.Header.Get("X-Organization-ID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": items})
}

func workspaceActor(r *http.Request) product.Actor {
	return requestActor(r)
}

func validWorkspaceNameAndSlug(name, slug string) bool {
	_, err := product.NormalizeWorkspaceName(name)
	return err == nil &&
		len(slug) >= 2 && len(slug) <= 100 && workspaceSlugPattern.MatchString(slug)
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var input product.CreateWorkspaceInput
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Name, input.Slug = strings.TrimSpace(input.Name), strings.TrimSpace(input.Slug)
	if !validWorkspaceNameAndSlug(input.Name, input.Slug) {
		writeError(w, http.StatusBadRequest, "invalid workspace name or slug")
		return
	}
	workspace, err := s.configuration.CreateWorkspace(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, workspaceMutationResponse(workspace))
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListWorkspaces(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": items})
}

func (s *Server) setActiveWorkspace(w http.ResponseWriter, r *http.Request) {
	var input struct {
		OrganizationID string `json:"organizationId"`
	}
	if decodeJSON(r, &input) != nil || input.OrganizationID == "" || len(input.OrganizationID) > 128 {
		writeError(w, http.StatusBadRequest, "organizationId is required")
		return
	}
	if err := s.configuration.SetActiveWorkspace(r.Context(), workspaceActor(r), input.OrganizationID); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"updated": true})
}

func (s *Server) getWorkspace(w http.ResponseWriter, r *http.Request) {
	workspace, err := s.configuration.GetWorkspace(r.Context(), r.Header.Get("X-Organization-ID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if workspace == nil {
		writeJSON(w, http.StatusOK, map[string]any{"workspace": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": workspaceResponse(workspace)})
}

func (s *Server) updateWorkspace(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input product.UpdateWorkspaceInput
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Name, input.Slug = strings.TrimSpace(input.Name), strings.TrimSpace(input.Slug)
	if !validWorkspaceNameAndSlug(input.Name, input.Slug) || !validWorkspaceUpdate(input) {
		writeError(w, http.StatusBadRequest, "invalid workspace settings")
		return
	}
	workspace, err := s.configuration.UpdateWorkspace(r.Context(), actor, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workspaceMutationResponse(workspace))
}

func validWorkspaceUpdate(input product.UpdateWorkspaceInput) bool {
	if input.DefaultPublishTime != nil && !publishTimePattern.MatchString(*input.DefaultPublishTime) {
		return false
	}
	if input.Description.Set && input.Description.Value != nil && utf8.RuneCountInString(*input.Description.Value) > 1000 {
		return false
	}
	if input.Locale != nil && (len(*input.Locale) > 35 || !localePattern.MatchString(*input.Locale)) {
		return false
	}
	if input.TimeZone != nil {
		if len(*input.TimeZone) > 100 {
			return false
		}
		if _, err := time.LoadLocation(*input.TimeZone); err != nil {
			return false
		}
	}
	if input.Logo.Set && input.Logo.Value != nil {
		logo, err := url.Parse(*input.Logo.Value)
		if err != nil || len(*input.Logo.Value) > 2000 || logo.Scheme != "https" || logo.Host == "" {
			return false
		}
	}
	return true
}

func workspaceResponse(workspace *product.Workspace) map[string]any {
	return map[string]any{
		"id": workspace.ID, "createdAt": workspace.CreatedAt, "logo": workspace.Logo, "name": workspace.Name, "slug": workspace.Slug,
		"workspaceSettings": workspaceSettingsResponse(workspace.WorkspaceSettings),
	}
}

func workspaceMutationResponse(workspace *product.Workspace) map[string]any {
	organization := map[string]any{"id": workspace.ID, "logo": workspace.Logo, "name": workspace.Name, "slug": workspace.Slug}
	response := map[string]any{
		"organization": organization,
		"settings":     workspaceSettingsResponse(workspace.WorkspaceSettings),
	}
	if workspace.CreationMember != nil {
		var metadata json.RawMessage
		if workspace.Metadata != nil {
			metadata = json.RawMessage(*workspace.Metadata)
		}
		organization["createdAt"], organization["metadata"] = workspace.CreatedAt, metadata
		response["creationMember"] = workspace.CreationMember
	}
	return response
}

func workspaceSettingsResponse(settings *ent.WorkspaceSettings) any {
	if settings == nil {
		return nil
	}
	return map[string]any{
		"organizationId": settings.ID, "description": settings.Description,
		"locale": settings.Locale, "timeZone": settings.TimeZone,
		"defaultPublishTime": settings.DefaultPublishTime, "aiAgentEnabled": settings.AiAgentEnabled,
		"createdAt": settings.CreatedAt, "updatedAt": settings.UpdatedAt,
	}
}

func (s *Server) pageAccess(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.PageAccess(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var workspace any
	if result.Workspace != nil {
		workspace = workspaceResponse(result.Workspace)
	}
	writeJSON(w, http.StatusOK, map[string]any{"active": result.Active, "count": result.Count, "workspace": workspace, "features": result.Features, "whitelabel": result.Whitelabel, "deniedPermissions": result.DeniedPermissions})
}

package httpapi

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// SettingsPlatformStore is the settings platform (RFC 024): a person's
// preferences, experiments and account deletion; social sets with their
// accounts, sharing, Writing Assistant and public profile.
type SettingsPlatformStore interface {
	GetUserPreferences(context.Context, product.Actor) (*product.UserPreferences, error)
	UpdateUserPreferences(context.Context, product.Actor, product.UserPreferencesUpdate) (*product.UserPreferences, error)
	ListExperiments(context.Context, product.Actor) ([]product.ExperimentState, error)
	SetWorkspaceExperiment(context.Context, product.Actor, string, bool) ([]product.ExperimentState, error)
	GetAccountDeletion(context.Context, product.Actor) (*product.AccountDeletionStatus, error)
	RequestAccountDeletion(context.Context, product.Actor, string) (*product.AccountDeletionStatus, error)
	CancelAccountDeletion(context.Context, product.Actor) (*product.AccountDeletionStatus, error)
	ListSocialSets(context.Context, product.Actor) (*product.SocialSetList, error)
	GetChannelCapacity(context.Context, product.Actor) (*product.ChannelCapacity, error)
	GetSocialSet(context.Context, product.Actor, string) (*product.SocialSetRecord, error)
	CreateSocialSet(context.Context, product.Actor, product.SocialSetInput) (*product.SocialSetRecord, error)
	UpdateSocialSet(context.Context, product.Actor, string, product.SocialSetUpdate) (*product.SocialSetRecord, error)
	UpdateSocialSetQueue(context.Context, product.Actor, string, product.SocialSetQueueUpdate) (*product.SocialSetRecord, error)
	ShareSocialSet(context.Context, product.Actor, string) (*product.SocialSetRecord, error)
	DeleteSocialSet(context.Context, product.Actor, string, string) (*product.SocialSetRemoval, error)
	AssignSocialSetAccount(context.Context, product.Actor, string, string) (*product.SocialSetRecord, error)
	RemoveSocialSetAccount(context.Context, product.Actor, string, string) (*product.SocialSetRemoval, error)
	ChannelAccountStates(context.Context, string, []*ent.ChannelConnection) (map[string]product.ChannelAccountState, error)
	RemoveChannelAccount(context.Context, product.Actor, string) (*product.SocialSetRemoval, error)
	AuthorizeChannelManage(context.Context, product.Actor) error
	AuthorizeSocialSetConnection(context.Context, product.Actor, string) error
	ListCopyableSocialSets(context.Context, product.Actor) ([]product.CopyableSocialSet, error)
	CopySocialSet(context.Context, product.Actor, string, string) (*product.SocialSetRecord, error)
	UpdateWritingAssistant(context.Context, product.Actor, string, product.WritingAssistantUpdate) (*product.SocialSetRecord, error)
	ListWritingSamples(context.Context, product.Actor, string) ([]product.WritingSampleRecord, error)
	AddWritingSample(context.Context, product.Actor, string, product.WritingSampleInput) (*product.WritingSampleRecord, error)
	DeleteWritingSample(context.Context, product.Actor, string, string) error
	DraftWritingContext(context.Context, product.Actor, string, string) (*product.WritingContext, error)
	GetPublicProfile(context.Context, string) (*product.PublicProfile, error)
}

func (s *Server) registerSettingsPlatform(mux *http.ServeMux) {
	product := func(handler http.HandlerFunc) http.Handler { return s.authenticateProduct(handler) }
	mux.Handle("GET /v1/me/preferences", product(s.getUserPreferences))
	mux.Handle("PATCH /v1/me/preferences", product(s.updateUserPreferences))
	mux.Handle("GET /v1/me/account-deletion", product(s.getAccountDeletion))
	mux.Handle("POST /v1/me/account-deletion", product(s.requestAccountDeletion))
	mux.Handle("DELETE /v1/me/account-deletion", product(s.cancelAccountDeletion))
	mux.Handle("GET /v1/experiments", product(s.listExperiments))
	mux.Handle("PUT /v1/experiments/{id}/workspace", product(s.setWorkspaceExperiment))
	mux.Handle("GET /v1/social-sets", product(s.listSocialSets))
	mux.Handle("POST /v1/social-sets", product(s.createSocialSet))
	mux.Handle("GET /v1/social-sets/copyable", product(s.listCopyableSocialSets))
	mux.Handle("POST /v1/social-sets/copy", product(s.copySocialSet))
	mux.Handle("GET /v1/social-sets/{id}", product(s.getSocialSet))
	mux.Handle("PATCH /v1/social-sets/{id}", product(s.updateSocialSet))
	mux.Handle("PATCH /v1/social-sets/{id}/queue", product(s.updateSocialSetQueue))
	mux.Handle("DELETE /v1/social-sets/{id}", product(s.deleteSocialSet))
	mux.Handle("POST /v1/social-sets/{id}/share", product(s.shareSocialSet))
	mux.Handle("POST /v1/social-sets/{id}/accounts/{connectionId}", product(s.assignSocialSetAccount))
	mux.Handle("DELETE /v1/social-sets/{id}/accounts/{connectionId}", product(s.removeSocialSetAccount))
	mux.Handle("DELETE /v1/channel-connections/{id}", product(s.removeChannelConnection))
	mux.Handle("POST /v1/channel-connections/{id}/refresh", product(s.refreshChannelConnection))
	mux.Handle("PUT /v1/social-sets/{id}/writing-assistant", product(s.updateWritingAssistant))
	mux.Handle("GET /v1/social-sets/{id}/writing-samples", product(s.listWritingSamples))
	mux.Handle("POST /v1/social-sets/{id}/writing-samples", product(s.addWritingSample))
	mux.Handle("DELETE /v1/social-sets/{id}/writing-samples/{sampleId}", product(s.deleteWritingSample))
	mux.Handle("GET /v1/content-drafts/{id}/writing-context", product(s.draftWritingContext))
	// A public profile page: only the web app, with the service credential, reads it.
	mux.Handle("GET /v1/internal/public-profiles/{slug}", s.authenticateService(http.HandlerFunc(s.getPublicProfile)))
}

// respond writes value, or the store error.
func respond[T any](w http.ResponseWriter, status int, value T, err error) {
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, status, value)
}

func (s *Server) getUserPreferences(w http.ResponseWriter, r *http.Request) {
	preferences, err := s.configuration.GetUserPreferences(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, preferences, err)
}

func (s *Server) updateUserPreferences(w http.ResponseWriter, r *http.Request) {
	var input product.UserPreferencesUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid preferences")
		return
	}
	preferences, err := s.configuration.UpdateUserPreferences(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, preferences, err)
}

func (s *Server) getAccountDeletion(w http.ResponseWriter, r *http.Request) {
	status, err := s.configuration.GetAccountDeletion(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, status, err)
}

func (s *Server) requestAccountDeletion(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid account deletion request")
		return
	}
	status, err := s.configuration.RequestAccountDeletion(r.Context(), workspaceActor(r), input.Confirmation)
	respond(w, http.StatusAccepted, status, err)
}

func (s *Server) cancelAccountDeletion(w http.ResponseWriter, r *http.Request) {
	status, err := s.configuration.CancelAccountDeletion(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, status, err)
}

func (s *Server) listExperiments(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListExperiments(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

func (s *Server) setWorkspaceExperiment(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Disabled bool `json:"disabled"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid experiment setting")
		return
	}
	items, err := s.configuration.SetWorkspaceExperiment(r.Context(), workspaceActor(r), r.PathValue("id"), input.Disabled)
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

// nameAccounts stores the names, handles and avatars of accounts that have
// none yet, as listing connections does, so a set shows its accounts as their
// platforms do. Best effort: a failure leaves the accounts as they are.
func (s *Server) nameAccounts(r *http.Request) {
	organizationID := r.Header.Get("X-Organization-ID")
	if connections, err := s.store.ListConnections(r.Context(), organizationID); err == nil {
		s.fillProfiles(r.Context(), organizationID, connections)
	}
}

func (s *Server) listSocialSets(w http.ResponseWriter, r *http.Request) {
	s.nameAccounts(r)
	list, err := s.configuration.ListSocialSets(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, list, err)
}

func (s *Server) getSocialSet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	s.nameAccounts(r)
	set, err := s.configuration.GetSocialSet(r.Context(), workspaceActor(r), id)
	respond(w, http.StatusOK, set, err)
}

func (s *Server) createSocialSet(w http.ResponseWriter, r *http.Request) {
	var input product.SocialSetInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid social set")
		return
	}
	set, err := s.configuration.CreateSocialSet(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusCreated, set, err)
}

func (s *Server) updateSocialSet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var input product.SocialSetUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid social set")
		return
	}
	set, err := s.configuration.UpdateSocialSet(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusOK, set, err)
}

func (s *Server) updateSocialSetQueue(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var input product.SocialSetQueueUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid queue settings")
		return
	}
	set, err := s.configuration.UpdateSocialSetQueue(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusOK, set, err)
}

func (s *Server) shareSocialSet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	set, err := s.configuration.ShareSocialSet(r.Context(), workspaceActor(r), id)
	respond(w, http.StatusOK, set, err)
}

func (s *Server) deleteSocialSet(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Confirmation string `json:"confirmation"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid social set deletion")
		return
	}
	removal, err := s.configuration.DeleteSocialSet(r.Context(), workspaceActor(r), id, input.Confirmation)
	respond(w, http.StatusOK, removal, err)
}

func (s *Server) assignSocialSetAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	connectionID, ok := pathID(w, r, "connectionId")
	if !ok {
		return
	}
	set, err := s.configuration.AssignSocialSetAccount(r.Context(), workspaceActor(r), id, connectionID)
	respond(w, http.StatusOK, set, err)
}

// removeSocialSetAccount stops the workflows of the posts the removal
// cancelled. A workflow that cannot be signalled still finds its post
// cancelled when it wakes, and does not publish it.
func (s *Server) removeSocialSetAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	connectionID, ok := pathID(w, r, "connectionId")
	if !ok {
		return
	}
	removal, err := s.configuration.RemoveSocialSetAccount(r.Context(), workspaceActor(r), id, connectionID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.stopCancelledPosts(r.Context(), removal.CancelledPostIDs)
	writeJSON(w, http.StatusOK, removal)
}

// removeChannelConnection removes an account from the workspace, in a
// publishing brand or in none, and stops the workflows of the posts it cancelled.
func (s *Server) removeChannelConnection(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	removal, err := s.configuration.RemoveChannelAccount(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	s.stopCancelledPosts(r.Context(), removal.CancelledPostIDs)
	writeJSON(w, http.StatusOK, removal)
}

// refreshChannelConnection reads an account's name, handle and picture from
// its platform again and answers with its current health. Credentials keep
// renewing in the background; one that cannot renew shows as needing a reconnect.
func (s *Server) refreshChannelConnection(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	actor := workspaceActor(r)
	if err := s.configuration.AuthorizeChannelManage(r.Context(), actor); err != nil {
		writeStoreError(w, err)
		return
	}
	connections, err := s.store.ListConnections(r.Context(), actor.OrganizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	var connection *ent.ChannelConnection
	for _, candidate := range connections {
		if candidate.ID == id && candidate.Status == channelconnection.StatusACTIVE {
			connection = candidate
		}
	}
	if connection == nil {
		writeError(w, http.StatusNotFound, "That account is not connected to this workspace.")
		return
	}
	profiler, ok := s.verifier.(destinationProfiles)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "Refreshing accounts is unavailable.")
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.OrganizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	profiles, err := profiler.Profiles(r.Context(), binding.SecretReference)
	if err != nil {
		slog.WarnContext(r.Context(), "channel profile refresh failed", "connection", id, "error", err)
		writeError(w, http.StatusBadGateway, "The platform did not answer. Try again in a moment.")
		return
	}
	if profile, found := profiles[connection.ExternalAccountID]; found && (profile.Name != "" || profile.Handle != "") {
		if connection, err = s.store.SetConnectionProfile(r.Context(), connection.ID, profile.Name, profile.Handle, profile.AvatarURL); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	states, err := s.configuration.ChannelAccountStates(r.Context(), actor.OrganizationID, []*ent.ChannelConnection{connection})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, connectionWithState(connection, states))
}

// stopCancelledPosts signals the workflows of posts a removal cancelled. A
// workflow that cannot be signalled still finds its post cancelled when it
// wakes, and does not publish it.
func (s *Server) stopCancelledPosts(ctx context.Context, postIDs []string) {
	for _, postID := range postIDs {
		if s.scheduler == nil {
			return
		}
		if err := s.scheduler.Cancel(ctx, postID); err != nil {
			slog.Warn("cancelled post workflow was not signalled", "post", postID)
		}
	}
}

func (s *Server) listCopyableSocialSets(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListCopyableSocialSets(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

func (s *Server) copySocialSet(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SocialSetID string `json:"socialSetId"`
		WorkspaceID string `json:"workspaceId"`
	}
	if err := decodeJSON(r, &input); err != nil || !resourceIDPattern.MatchString(input.SocialSetID) || input.WorkspaceID == "" {
		writeError(w, http.StatusBadRequest, "invalid social set copy")
		return
	}
	set, err := s.configuration.CopySocialSet(r.Context(), workspaceActor(r), input.WorkspaceID, input.SocialSetID)
	respond(w, http.StatusCreated, set, err)
}

func (s *Server) updateWritingAssistant(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var input product.WritingAssistantUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid writing assistant")
		return
	}
	set, err := s.configuration.UpdateWritingAssistant(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusOK, set, err)
}

func (s *Server) listWritingSamples(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	items, err := s.configuration.ListWritingSamples(r.Context(), workspaceActor(r), id)
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

func (s *Server) addWritingSample(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var input product.WritingSampleInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid writing sample")
		return
	}
	sample, err := s.configuration.AddWritingSample(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusCreated, sample, err)
}

func (s *Server) deleteWritingSample(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	sampleID, ok := pathID(w, r, "sampleId")
	if !ok {
		return
	}
	if err := s.configuration.DeleteWritingSample(r.Context(), workspaceActor(r), id, sampleID); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) draftWritingContext(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	writing, err := s.configuration.DraftWritingContext(r.Context(), workspaceActor(r), id, r.URL.Query().Get("channel"))
	respond(w, http.StatusOK, writing, err)
}

func (s *Server) getPublicProfile(w http.ResponseWriter, r *http.Request) {
	profile, err := s.configuration.GetPublicProfile(r.Context(), r.PathValue("slug"))
	respond(w, http.StatusOK, profile, err)
}

package integration

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
)

// RefreshIntegrationService is the refresh integration service.
type RefreshIntegrationService struct {
	manager  *integrations.Manager
	service  *Service
	temporal client.Client
}

func NewRefreshIntegrationService(manager *integrations.Manager, service *Service, temporal client.Client) *RefreshIntegrationService {
	return &RefreshIntegrationService{manager: manager, service: service, temporal: temporal}
}

// Refresh returns nil (TypeScript's false) when the token could not be
// refreshed; the channel is then flagged and the user notified. Every caller
// (the scheduled job, analytics) shares one lock per account, so a refresh
// already in flight answers ErrRefreshChanged.
func (r *RefreshIntegrationService) Refresh(ctx context.Context, integration *ent.Integration, cause string) (*integrations.AuthTokenDetails, error) {
	if integration == nil {
		return nil, ErrRefreshChanged
	}
	provider := r.manager.GetSocialIntegration(integration.ProviderIdentifier)
	if provider == nil {
		return nil, fmt.Errorf("unknown provider %s", integration.ProviderIdentifier)
	}

	unlock, err := r.service.repo.lockRefresh(ctx, integration)
	if err != nil {
		return nil, err
	}
	defer unlock()
	snapshot, err := r.service.repo.prepareRefresh(ctx, integration, provider.Info().OneTimeToken)
	if err != nil {
		return nil, err
	}
	refresh, err := r.refreshProcess(ctx, snapshot.connection, provider, cause)
	if err != nil || refresh == nil {
		return nil, err
	}

	if refresh.ID != "" && refresh.ID != snapshot.connection.InternalID {
		return nil, errors.New("provider refresh returned a different account identity")
	}
	if err := r.service.repo.saveRefresh(ctx, snapshot, refresh); err != nil {
		return nil, err
	}

	return refresh, nil
}

func (r *RefreshIntegrationService) SetBetweenSteps(ctx context.Context, integration *ent.Integration, cause string) error {
	if err := r.service.repo.markRefreshFailure(ctx, integration, true); err != nil {
		return err
	}
	return r.service.InformAboutRefreshError(ctx, integration.OrganizationID, integration, cause)
}

// StartRefreshWorkflow starts refreshTokenWorkflow for providers with
// refreshCron; it returns nil when the provider has none or Temporal is not
// connected.
func (r *RefreshIntegrationService) StartRefreshWorkflow(ctx context.Context, orgID, id string, provider integrations.Provider) (client.WorkflowRun, error) {
	if !provider.Info().RefreshCron || r.temporal == nil {
		return nil, nil
	}
	return r.temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       "refresh_" + id,
		TaskQueue:                temporalx.MainQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_TERMINATE_EXISTING,
	}, "refreshTokenWorkflow", map[string]string{"integrationId": id, "organizationId": orgID})
}

func (r *RefreshIntegrationService) refreshProcess(ctx context.Context, integration *ent.Integration, provider integrations.Provider, cause string) (*integrations.AuthTokenDetails, error) {
	refreshToken := ""
	if integration.RefreshToken != nil {
		refreshToken = *integration.RefreshToken
	}
	var refresh *integrations.AuthTokenDetails
	var refreshError error
	if contextual, ok := provider.(integrations.IntegrationRefresher); ok {
		refresh, refreshError = contextual.RefreshIntegration(ctx, integration)
	} else {
		refresh, refreshError = provider.RefreshToken(ctx, refreshToken)
	}
	if errors.Is(refreshError, integrations.ErrRefreshUnavailable) || errors.Is(refreshError, context.Canceled) || errors.Is(refreshError, context.DeadlineExceeded) {
		return nil, refreshError
	}

	if refreshError != nil || refresh == nil || refresh.AccessToken == "" {
		if refreshError != nil {
			slog.Warn("Provider credential refresh failed", "provider", integration.ProviderIdentifier, "integration_id", integration.ID)
		}

		// informAboutRefreshError (with the failure cause) already notifies
		// the user, and refreshNeeded sets the same flag disconnectChannel
		// would — calling disconnectChannel here sent a second, cause-less
		// copy of the same email for every failed refresh.
		if err := r.service.repo.markRefreshFailure(ctx, integration, false); err != nil {
			return nil, err
		}

		message := ""
		if m, ok := provider.(integrations.RefreshErrorMessager); ok {
			message = m.RefreshErrorMessage(refreshError)
		}
		if message == "" {
			message = cause
		}
		return nil, r.service.InformAboutRefreshError(ctx, integration.OrganizationID, integration, message)
	}

	reconnector, ok := provider.(integrations.Reconnector)
	root := ""
	if integration.RootInternalID != nil {
		root = *integration.RootInternalID
	}
	if !ok || (integration.RootInternalID != nil && root == integration.InternalID) {
		return refresh, nil
	}

	reConnect, err := reconnector.ReConnect(ctx, root, integration.InternalID, refresh.AccessToken)
	if err != nil {
		slog.Warn("Provider identity verification failed after credential refresh", "provider", integration.ProviderIdentifier, "integration_id", integration.ID)
		return nil, errors.New("provider identity verification failed after credential refresh")
	}

	return mergeAuth(*refresh, reConnect), nil
}

// mergeAuth is `{...refresh, ...reConnect}`: what reConnect sets wins.
func mergeAuth(out integrations.AuthTokenDetails, over *integrations.AuthTokenDetails) *integrations.AuthTokenDetails {
	if over == nil {
		return &out
	}
	if over.ID != "" {
		out.ID = over.ID
	}
	if over.Name != "" {
		out.Name = over.Name
	}
	if over.Error != "" {
		out.Error = over.Error
	}
	if over.AccessToken != "" {
		out.AccessToken = over.AccessToken
	}
	if over.RefreshToken != "" {
		out.RefreshToken = over.RefreshToken
	}
	if over.NonExpiring {
		out.NonExpiring = true
		out.ExpiresIn = 0
	} else if over.ExpiresIn != 0 {
		out.NonExpiring = false
		out.ExpiresIn = over.ExpiresIn
	}
	if over.Picture != "" {
		out.Picture = over.Picture
	}
	if over.Username != "" {
		out.Username = over.Username
	}
	if over.AdditionalSettings != nil {
		out.AdditionalSettings = over.AdditionalSettings
	}
	return &out
}

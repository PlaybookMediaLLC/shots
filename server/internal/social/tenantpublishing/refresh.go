package tenantpublishing

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"entgo.io/ent/dialect/sql"
	socialintegration "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/integration"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// TokenRefreshWindow is how long before expiry a channel token is renewed.
// Long-lived tokens leave a week for retries; video providers renew near expiry.
const TokenRefreshWindow = 7 * 24 * time.Hour

// tokenRefreshBatch bounds one run; the next scheduled run takes the rest.
const tokenRefreshBatch = 50

// newRefresh reuses the social refresh service and its conditional writes. It
// has no notifier: the product learns of a failed refresh from refreshNeeded.
func newRefresh(client *socialent.Client, manager *integrations.Manager) *socialintegration.RefreshIntegrationService {
	return socialintegration.NewService(socialintegration.NewRepository(client, nil), nil, manager, nil, nil, nil, nil).RefreshIntegrationService()
}

// RefreshSocialTokens renews the credentials of healthy channels in live
// workspaces that expire within TokenRefreshWindow and returns how many it
// renewed. A rejected refresh marks the channel refreshNeeded, so the product
// asks for a reconnect; a temporary failure leaves it for the next run.
func (p *Publisher) RefreshSocialTokens(ctx context.Context) (int, error) {
	due, err := p.channels.Integration.Query().Where(
		integration.Or(
			integration.And(integration.ProviderIdentifierIn("threads", "instagram-standalone", "linkedin", "linkedin-page", "pinterest"), integration.TokenExpirationLTE(p.currentTime().Add(TokenRefreshWindow))),
			integration.And(integration.ProviderIdentifierIn("youtube", "tiktok", "gmb"), integration.TokenExpirationLTE(p.currentTime().Add(15*time.Minute))),
		),
		integration.Or(integration.ProviderIdentifierIn("threads", "instagram-standalone"), integration.RefreshTokenNotNil()),
		integration.DeletedAtIsNil(), integration.Disabled(false), integration.RefreshNeeded(false), integration.InBetweenSteps(false),
		integration.HasOrganizationWith(organization.DeletedAtIsNil()),
		func(s *sql.Selector) {
			// Only channels of a bound workspace that is not being deleted.
			s.Where(sql.ExprP(`EXISTS (SELECT 1 FROM social_tenant_binding b WHERE b."goOrganizationId" = ` + s.C(integration.FieldOrganizationID) +
				` AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId" = b."organizationId" AND d.status <> 'CANCELLED'))`))
		},
	).Order(socialent.Asc(integration.FieldTokenExpiration)).Limit(tokenRefreshBatch).All(ctx)
	if err != nil {
		return 0, err
	}
	renewed := 0
	for _, channel := range due {
		auth, err := p.refresh.Refresh(ctx, channel, "")
		if ctx.Err() != nil {
			return renewed, ctx.Err()
		}
		switch {
		case errors.Is(err, socialintegration.ErrRefreshChanged):
			// Reconnected, removed or renewed meanwhile; the next run reads it again.
		case err != nil:
			// Provider errors can carry the token (Threads sends it in the URL), so log no error text.
			slog.Warn("social token refresh failed", "provider", channel.ProviderIdentifier, "integration_id", channel.ID,
				"temporary", errors.Is(err, integrations.ErrRefreshUnavailable))
		case auth == nil:
			slog.Warn("social channel needs reconnecting", "provider", channel.ProviderIdentifier, "integration_id", channel.ID)
		default:
			renewed++
		}
	}
	return renewed, nil
}

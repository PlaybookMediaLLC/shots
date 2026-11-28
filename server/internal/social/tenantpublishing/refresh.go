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

const (
	refreshCooldownBase = 15 * time.Minute
	refreshCooldownMax  = 4 * time.Hour
	refreshCooldownCap  = 10_000
)

type refreshBackoff struct {
	until    time.Time
	failures int
}

// newRefresh reuses the social refresh service and its conditional writes. It
// has no notifier: the product learns of a failed refresh from refreshNeeded.
func newRefresh(client *socialent.Client, manager *integrations.Manager) *socialintegration.RefreshIntegrationService {
	return socialintegration.NewService(socialintegration.NewRepository(client, nil), nil, manager, nil, nil, nil, nil).RefreshIntegrationService()
}

func (p *Publisher) activeCooldownIDs(now time.Time) []string {
	p.refreshMu.Lock()
	defer p.refreshMu.Unlock()
	if len(p.refreshCooldown) == 0 {
		return nil
	}
	var skip []string
	for id, entry := range p.refreshCooldown {
		if now.Before(entry.until) {
			skip = append(skip, id)
		} else if now.After(entry.until.Add(refreshCooldownMax)) {
			// Retain failure counts across retry windows so exponential backoff
			// escalates, and prune only entries that have been idle past max backoff.
			delete(p.refreshCooldown, id)
		}
	}
	return skip
}

func (p *Publisher) recordRefreshFailure(id string, now time.Time) {
	p.refreshMu.Lock()
	defer p.refreshMu.Unlock()
	if p.refreshCooldown == nil {
		p.refreshCooldown = make(map[string]refreshBackoff)
	}
	entry, exists := p.refreshCooldown[id]
	if !exists && len(p.refreshCooldown) >= refreshCooldownCap {
		for k, e := range p.refreshCooldown {
			if now.After(e.until.Add(refreshCooldownMax)) {
				delete(p.refreshCooldown, k)
			}
		}
		if len(p.refreshCooldown) >= refreshCooldownCap {
			return
		}
	}
	entry.failures++
	shift := min(entry.failures-1, 4)
	wait := min(refreshCooldownMax, refreshCooldownBase<<shift)
	entry.until = now.Add(wait)
	p.refreshCooldown[id] = entry
}

func (p *Publisher) clearRefreshFailure(id string) {
	p.refreshMu.Lock()
	delete(p.refreshCooldown, id)
	p.refreshMu.Unlock()
}

// RefreshSocialTokens renews the credentials of healthy channels in live
// workspaces that expire within TokenRefreshWindow and returns how many it
// renewed. A rejected refresh marks the channel refreshNeeded, so the product
// asks for a reconnect; a temporary failure enters exponential cooldown so
// persistently failing tokens cannot starve healthy ones.
func (p *Publisher) RefreshSocialTokens(ctx context.Context) (int, error) {
	now := p.currentTime()
	query := p.channels.Integration.Query().Where(
		integration.Or(
			integration.And(integration.ProviderIdentifierIn("threads", "instagram-standalone", "linkedin", "linkedin-page", "pinterest"), integration.TokenExpirationLTE(now.Add(TokenRefreshWindow))),
			integration.And(integration.ProviderIdentifierIn("youtube", "tiktok", "gmb"), integration.TokenExpirationLTE(now.Add(15*time.Minute))),
		),
		integration.Or(integration.ProviderIdentifierIn("threads", "instagram-standalone"), integration.RefreshTokenNotNil()),
		integration.DeletedAtIsNil(), integration.Disabled(false), integration.RefreshNeeded(false), integration.InBetweenSteps(false),
		integration.HasOrganizationWith(organization.DeletedAtIsNil()),
		func(s *sql.Selector) {
			// Only channels of a bound workspace that is not being deleted.
			s.Where(sql.ExprP(`EXISTS (SELECT 1 FROM social_tenant_binding b WHERE b."goOrganizationId" = ` + s.C(integration.FieldOrganizationID) +
				` AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId" = b."organizationId" AND d.status <> 'CANCELLED'))`))
		},
	)
	if skip := p.activeCooldownIDs(now); len(skip) > 0 {
		query = query.Where(func(s *sql.Selector) {
			s.Where(sql.P(func(b *sql.Builder) {
				b.WriteString("NOT (" + s.C(integration.FieldID) + " = ANY(")
				b.Arg(skip)
				b.WriteString("))")
			}))
		})
	}
	due, err := query.Order(socialent.Asc(integration.FieldTokenExpiration)).Limit(tokenRefreshBatch).All(ctx)
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
			p.clearRefreshFailure(channel.ID)
			// Reconnected, removed or renewed meanwhile; the next run reads it again.
		case err != nil:
			p.recordRefreshFailure(channel.ID, p.currentTime())
			// Provider errors can carry the token (Threads sends it in the URL), so log no error text.
			slog.Warn("social token refresh failed", "provider", channel.ProviderIdentifier, "integration_id", channel.ID,
				"temporary", errors.Is(err, integrations.ErrRefreshUnavailable))
		case auth == nil:
			p.clearRefreshFailure(channel.ID)
			slog.Warn("social channel needs reconnecting", "provider", channel.ProviderIdentifier, "integration_id", channel.ID)
			p.notifyReconnect(ctx, channel, "token_refresh_rejected")
		default:
			p.clearRefreshFailure(channel.ID)
			renewed++
		}
	}
	return renewed, nil
}

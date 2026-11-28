package product

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformoauthaccesstoken"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformoauthrefreshtoken"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// RevokeAllSessionsResult summarizes an atomic global sign-out for a person.
type RevokeAllSessionsResult struct {
	RevokedSessions    int `json:"revokedSessions"`
	RevokedOAuthTokens int `json:"revokedOAuthTokens"`
}

// RevokeAllSessions atomically signs the authenticated person out of every
// browser session and revokes active OAuth refresh/access tokens (including
// Founder Hub), recording an audit entry in each workspace they belong to.
// API keys cannot invoke this operation.
func (c *Configuration) RevokeAllSessions(ctx context.Context, actor Actor) (*RevokeAllSessionsResult, error) {
	if !actor.IsSession() || actor.UserID == "" {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	// Revoke/delete OAuth tokens before deleting sessions so any FK cascade
	// cannot mask revoked token counts, and only count/mutate unexpired refresh tokens.
	revokedRefresh, err := tx.PlatformOAuthRefreshToken.Update().
		Where(
			platformoauthrefreshtoken.UserID(actor.UserID),
			platformoauthrefreshtoken.RevokedIsNil(),
			platformoauthrefreshtoken.ExpiresAtGT(now),
		).
		SetRevoked(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	deletedAccess, err := tx.PlatformOAuthAccessToken.Delete().
		Where(platformoauthaccesstoken.UserID(actor.UserID)).Exec(ctx)
	if err != nil {
		return nil, err
	}
	deletedSessions, err := tx.Session.Delete().Where(session.UserID(actor.UserID)).Exec(ctx)
	if err != nil {
		return nil, err
	}

	memberships, err := tx.Member.Query().
		Where(member.UserID(actor.UserID)).
		Order(ent.Asc(member.FieldOrganizationID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	meta := map[string]any{
		"revokedSessions":    deletedSessions,
		"revokedOAuthTokens": revokedRefresh + deletedAccess,
	}
	for _, membership := range memberships {
		scoped := actor
		scoped.OrganizationID = membership.OrganizationID
		if err := appendConfigurationAudit(ctx, tx, scoped, "product.sessions_revoked_all", "user", actor.UserID, meta); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// Evict live collaboration WebSocket sessions immediately across workspaces.
	c.collabAccessChanged(ctx, "")
	return &RevokeAllSessionsResult{
		RevokedSessions:    deletedSessions,
		RevokedOAuthTokens: revokedRefresh + deletedAccess,
	}, nil
}

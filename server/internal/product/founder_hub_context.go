package product

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func (c *Configuration) founderHubAuthenticatedTx(ctx context.Context, actor Actor) (*ent.Tx, *FounderHubProfile, error) {
	if !actor.IsSession() {
		return nil, nil, publishing.ErrForbidden
	}
	session, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, nil, err
	}
	profile, err := c.GetFounderHubProfile(ctx, actor.UserID)
	if err != nil {
		return nil, nil, err
	}
	snapshot, err := json.Marshal(FounderHubSession{FounderHubProfile: profile, SessionID: session.ID, ExpiresAt: session.ExpiresAt})
	if err != nil {
		return nil, nil, err
	}
	entitlements := []string{}
	for _, workspace := range profile.Workspaces {
		if workspace.Features["workspace:paid"] && slices.Contains(workspace.Permissions, "workspace:read") {
			entitlements = []string{"hyprnote_pro"}
			break
		}
	}
	claims, err := json.Marshal(map[string]any{"sub": profile.AccountUserID, "role": "shots_hub_authenticated", "aud": "authenticated", "email": profile.User.Email, "shots_revision": profile.Revision, "shots_session_id": session.ID, "entitlements": entitlements})
	if err != nil {
		return nil, nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT founder_hub.project_shots_authority($1::jsonb)`, string(snapshot)); err != nil {
		_ = tx.Rollback()
		return nil, nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT set_config('request.jwt.claims',$1,true)`, string(claims)); err != nil {
		_ = tx.Rollback()
		return nil, nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SET LOCAL ROLE shots_hub_authenticated`); err != nil {
		_ = tx.Rollback()
		return nil, nil, err
	}
	return tx, profile, nil
}

package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
)

// Serialize workspace mutations before holding the session and user identity
// through commitment. All authorization reads must use the transaction client.
func lockWorkspaceSession(ctx context.Context, tx *ent.Tx, actor Actor, org string) error {
	if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	found, err := workspaceplan.LockWorkspace(ctx, tx, org)
	if err != nil {
		return err
	}
	if !found {
		return publishing.ErrNotFound
	}
	for _, q := range []struct {
		sql string
		id  string
	}{
		{`SELECT id FROM session WHERE id=$1 FOR UPDATE`, actor.SessionID},
		{`SELECT id FROM "user" WHERE id=$1 FOR SHARE`, actor.UserID},
	} {
		if _, err := tx.PlatformExec(ctx, q.sql, q.id); err != nil {
			return err
		}
	}
	return nil
}

func lockWorkspaceMembership(ctx context.Context, tx *ent.Tx, actor Actor) error {
	if err := lockWorkspaceSession(ctx, tx, actor, actor.OrganizationID); err != nil {
		return err
	}
	_, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR UPDATE`, actor.OrganizationID, actor.UserID)
	return err
}

func workspaceAdministrator(ctx context.Context, tx *ent.Tx, actor Actor, permission string) error {
	if err := lockWorkspaceMembership(ctx, tx, actor); err != nil {
		return err
	}
	if err := NewConfiguration(tx.Client()).Authorize(ctx, actor); err != nil {
		return err
	}
	return requireNotDenied(ctx, tx.Client(), actor, permission)
}

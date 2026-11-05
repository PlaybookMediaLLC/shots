package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// DeleteCanvas removes this workspace's canvas and versions atomically. Campaign
// deliveries are independent snapshots and remain available after deletion.
func (c *Configuration) DeleteCanvas(ctx context.Context, actor Actor, id string) error {
	return c.deleteCreativeSetOfKind(ctx, actor, id, platformcreativeset.KindCanvas)
}

// DeleteStoreProject removes this workspace's copy of a store screenshot project
// and its versions; the browsers that made it keep their own copies.
func (c *Configuration) DeleteStoreProject(ctx context.Context, actor Actor, id string) error {
	return c.deleteCreativeSetOfKind(ctx, actor, id, platformcreativeset.KindStore)
}

// deleteCreativeSetOfKind removes one row of `kind` and its versions in one
// transaction. A row of another kind or workspace is not found.
func (c *Configuration) deleteCreativeSetOfKind(ctx context.Context, actor Actor, id string, kind platformcreativeset.Kind) error {
	if err := c.authorizeRoles(ctx, actor, creativeSetEditRoles...); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.KindEQ(kind)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.PlatformCreativeSetVersion.Delete().Where(platformcreativesetversion.CreativeSetID(id), platformcreativesetversion.OrganizationID(actor.OrganizationID)).Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.PlatformCreativeSet.Delete().Where(platformcreativeset.ID(id), platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.KindEQ(kind)).Exec(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(kind, "deleted"), "creativeSet", id, map[string]any{"name": row.Name}); err != nil {
		return err
	}
	return tx.Commit()
}

package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organizationenterprisesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
)

// WhitelabelFeature is the plan feature that lets an organization brand the app.
const WhitelabelFeature = "enterprise:white-label"

// GetWhitelabel returns the stored branding to any member. It is returned even
// when the plan no longer grants the feature, so an admin can see what lapsed;
// PageAccess decides whether it is applied.
func (c *Configuration) GetWhitelabel(ctx context.Context, actor Actor) (*whitelabel.Settings, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	return c.storedWhitelabel(ctx, actor.OrganizationID)
}

func (c *Configuration) storedWhitelabel(ctx context.Context, organizationID string) (*whitelabel.Settings, error) {
	row, err := c.client.OrganizationEnterpriseSettings.Query().
		Where(organizationenterprisesettings.ID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return &whitelabel.Settings{}, nil
	}
	if err != nil {
		return nil, err
	}
	return &row.WhitelabelSettings, nil
}

// UpdateWhitelabel replaces the branding. It needs the same fresh, two-factor
// owner or admin session as the other enterprise controls, and the plan feature.
func (c *Configuration) UpdateWhitelabel(ctx context.Context, actor Actor, input whitelabel.Settings, request AuditRequest) (*whitelabel.Settings, error) {
	if err := c.authorizeAuditManage(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, WhitelabelFeature); err != nil {
		return nil, err
	}
	settings, ok := whitelabel.Normalize(input)
	if !ok {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	exists, err := tx.OrganizationEnterpriseSettings.Query().
		Where(organizationenterprisesettings.ID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if exists {
		err = tx.OrganizationEnterpriseSettings.UpdateOneID(actor.OrganizationID).SetWhitelabelSettings(settings).Exec(ctx)
	} else {
		err = tx.OrganizationEnterpriseSettings.Create().SetID(actor.OrganizationID).SetWhitelabelSettings(settings).Exec(ctx)
	}
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := appendRequestAudit(ctx, tx, actor, request, "organization.whitelabel_changed", "organization", actor.OrganizationID,
		map[string]any{"whitelabel": settings}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &settings, nil
}

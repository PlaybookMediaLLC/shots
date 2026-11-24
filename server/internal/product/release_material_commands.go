package product

import (
	"context"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

// ReadinessMutation returns durable references, including on an exact retry.
type ReadinessMutation struct {
	Created  bool     `json:"created"`
	Revision string   `json:"revision"`
	ID       string   `json:"id"`
	IDs      []string `json:"ids"`
}

// Material mutations reuse the qualification receipt and authority transaction.
// Human-only authorship and exact input locks are stricter than legacy intake.
func (c *Configuration) materialCommand(ctx context.Context, actor Actor, releaseID, key, expected, operation string, input any, policy readinessCommandPolicy,
	apply func(context.Context, *ent.Tx, *ent.ReleaseReadiness) ([]string, error)) (*ReadinessMutation, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	result, err := c.readinessCommand(ctx, actor, releaseID, key, expected, operation, "", releasefacts.Facts{}, input,
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) (*releasefacts.Result, error) {
			if string(root.CanonicalState) != "ACTIVE" {
				return nil, qualificationConflict("RELEASE_INACTIVE", root.HeadRevision)
			}
			ids, err := apply(ctx, tx, root)
			if err != nil {
				return nil, err
			}
			if len(ids) == 0 {
				return nil, ErrInvalidInput
			}
			revision := strconv.FormatInt(root.HeadRevision+1, 10)
			if err := tx.ReleaseReadiness.UpdateOneID(root.ID).SetHeadRevision(root.HeadRevision + 1).Exec(ctx); err != nil {
				return nil, err
			}
			if err := appendConfigurationAudit(ctx, tx, actor, "product."+operation, "release", releaseID,
				map[string]any{"resourceIds": ids, "revision": revision}); err != nil {
				return nil, err
			}
			if operation != "release_claim.legacy_imported" {
				if err := activity.Emit(ctx, tx, actor.OrganizationID, "release.readiness_changed", "release", releaseID, actor.UserID,
					releaseID+":"+revision, map[string]any{"operation": operation, "resourceIds": ids, "recipientUserIds": []string{actor.UserID}}); err != nil {
					return nil, err
				}
			}
			return &releasefacts.Result{Created: true, Revision: revision, ResourceID: ids[0], ResourceIDs: ids}, nil
		}, policy)
	if err != nil {
		return nil, err
	}
	return &ReadinessMutation{Created: result.Created, Revision: result.Revision, ID: result.ResourceID, IDs: result.ResourceIDs}, nil
}

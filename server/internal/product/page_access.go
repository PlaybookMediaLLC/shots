package product

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
)

// PageAccessSnapshot contains only what the signed-in page gate needs.
// It includes pending deletion workspaces so their owner can reach recovery.
type PageAccessSnapshot struct {
	Active    *ListedWorkspace `json:"active"`
	Count     int              `json:"count"`
	Workspace *Workspace       `json:"workspace"`
	Features  map[string]bool  `json:"features"`
	// DeniedPermissions is what the member's permission group subtracts from
	// their role in the active workspace.
	DeniedPermissions []string `json:"deniedPermissions"`
	// Whitelabel is the active organization's branding, set only while its
	// plan grants the feature.
	Whitelabel *whitelabel.Settings `json:"whitelabel"`
}

func (c *Configuration) PageAccess(ctx context.Context, actor Actor) (*PageAccessSnapshot, error) {
	current, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, err
	}
	workspaces, err := c.ListWorkspaces(ctx, actor)
	if err != nil {
		return nil, err
	}
	result := &PageAccessSnapshot{Count: len(workspaces), DeniedPermissions: []string{}, Features: map[string]bool{}}
	if len(workspaces) == 0 {
		return result, nil
	}
	result.Active = &workspaces[0]
	for i := range workspaces {
		if current.ActiveOrganizationID != nil && workspaces[i].ID == *current.ActiveOrganizationID {
			result.Active = &workspaces[i]
			break
		}
	}
	if current.ActiveOrganizationID == nil || *current.ActiveOrganizationID != result.Active.ID {
		if err := c.SetActiveWorkspace(ctx, actor, result.Active.ID); err != nil {
			return nil, err
		}
	}
	if result.Active.IsScheduledForDeletion {
		return result, nil
	}
	actor.OrganizationID = result.Active.ID
	// The session check and ListWorkspaces already read this request's session,
	// membership and deletion state, so only AuthorizeRead's role gate remains.
	if !workspaceroles.Allows(result.Active.Role, readRoles...) {
		return nil, publishing.ErrForbidden
	}
	if result.DeniedPermissions, err = deniedPermissions(ctx, c.client, actor.OrganizationID, actor.UserID, result.Active.Role); err != nil {
		return nil, err
	}
	result.Workspace, err = c.GetWorkspace(ctx, actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	if result.Workspace == nil {
		return result, nil
	}
	entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	_, _, result.Features = evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	if result.Features[WhitelabelFeature] {
		if result.Whitelabel, err = c.storedWhitelabel(ctx, actor.OrganizationID); err != nil {
			return nil, err
		}
	}
	return result, nil
}

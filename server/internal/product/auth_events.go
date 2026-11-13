package product

import (
	"context"
	"regexp"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// AuthEvent is the product side effect of a Better Auth organization change.
// Better Auth commits its own rows through the auth store; the backend then
// records the audit entry and any product rows that belong to the change.
type AuthEvent struct {
	Action         string         `json:"action"`
	ActorDisplay   string         `json:"actorDisplay"`
	ActorUserID    string         `json:"actorUserId"`
	EntityID       string         `json:"entityId"`
	EntityType     string         `json:"entityType"`
	Metadata       map[string]any `json:"metadata"`
	OrganizationID string         `json:"organizationId"`
	RemovedUserID  string         `json:"removedUserId"`
	RequestID      string         `json:"requestId"`
}

var authEventActions = map[string]bool{
	"product.member_invitation_accepted": true, "product.member_invitation_rejected": true,
	"product.member_invitation_revoked": true, "product.member_invited": true, "product.member_removed": true,
	"product.member_role_changed": true, "product.workspace_created": true, "product.workspace_updated": true,
}

func (c *Configuration) RecordAuthEvent(ctx context.Context, event AuthEvent) error {
	if !authEventActions[event.Action] || event.OrganizationID == "" || event.EntityID == "" || event.EntityType == "" {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	switch event.Action {
	case "product.workspace_created":
		// A replayed event finds the rows already provisioned. A failed insert
		// would abort the transaction, so existence is checked first.
		if exists, err := tx.WorkspaceSettings.Query().Where(workspacesettings.ID(event.OrganizationID)).Exist(ctx); err != nil {
			return err
		} else if !exists {
			if err := tx.WorkspaceSettings.Create().SetID(event.OrganizationID).Exec(ctx); err != nil {
				return err
			}
		}
		if exists, err := tx.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(event.OrganizationID)).Exist(ctx); err != nil {
			return err
		} else if !exists {
			if err := tx.WorkspaceEntitlement.Create().SetID(event.OrganizationID).Exec(ctx); err != nil {
				return err
			}
		}
	case "product.member_removed":
		// A removed member's sessions in this workspace end with the membership.
		if event.RemovedUserID == "" {
			return ErrInvalidInput
		}
		if _, err := tx.Session.Delete().Where(session.ActiveOrganizationID(event.OrganizationID),
			session.UserID(event.RemovedUserID)).Exec(ctx); err != nil {
			return err
		}
		// So do the keys their AI agent consents minted (SCIM and enterprise removals).
		service := Actor{OrganizationID: event.OrganizationID, Kind: "service", RequestID: event.RequestID, Display: "membership provisioning"}
		if err := revokeAgentKeys(ctx, tx, service, event.OrganizationID, event.RemovedUserID, event.EntityID); err != nil {
			return err
		}
	}
	actor := publishing.Actor{Organization: event.OrganizationID, RequestID: event.RequestID, Type: "SERVICE"}
	if event.ActorUserID != "" {
		actor.Type, actor.UserID, actor.Display = "USER", event.ActorUserID, event.ActorDisplay
	}
	if err := publishing.AppendAudit(ctx, tx, publishing.AuditInput{
		Action: event.Action, Actor: actor, EntityID: event.EntityID, EntityType: event.EntityType,
		Metadata: event.Metadata, Organization: event.OrganizationID, Outcome: auditlog.OutcomeSUCCEEDED,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

var (
	auditActionPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$`)
	auditEntityPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
)

// AuditEventInput is an audit entry for work the web performed outside a
// backend write, such as an AI generation run.
type AuditEventInput struct {
	Action           string         `json:"action"`
	EntityID         string         `json:"entityId"`
	EntityType       string         `json:"entityType"`
	IPHash           string         `json:"ipHash"`
	Metadata         map[string]any `json:"metadata"`
	Outcome          string         `json:"outcome"`
	UserAgentSummary string         `json:"userAgentSummary"`
}

func (c *Configuration) AppendAuditEvent(ctx context.Context, actor Actor, input AuditEventInput) error {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return err
	}
	outcome := auditlog.Outcome(strings.ToUpper(input.Outcome))
	if input.Outcome == "" {
		outcome = auditlog.OutcomeSUCCEEDED
	}
	if len(input.Action) > 100 || !auditActionPattern.MatchString(input.Action) ||
		len(input.EntityType) > 50 || !auditEntityPattern.MatchString(input.EntityType) ||
		len(input.EntityID) > 200 || len(input.IPHash) > 128 || len(input.UserAgentSummary) > 256 ||
		auditlog.OutcomeValidator(outcome) != nil {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := publishing.AppendAudit(ctx, tx, publishing.AuditInput{
		Action: input.Action, Actor: actor.auditActor(), EntityID: input.EntityID, EntityType: input.EntityType,
		IPHash: input.IPHash, Metadata: input.Metadata, Organization: actor.OrganizationID, Outcome: outcome,
		UserAgentSummary: input.UserAgentSummary,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// WorkspaceOperational reports whether a workspace exists and is not
// scheduled for deletion.
func (c *Configuration) WorkspaceOperational(ctx context.Context, organizationID string) (bool, error) {
	deletion, err := c.client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return deletion.Status == workspacedeletion.StatusCANCELLED, nil
}

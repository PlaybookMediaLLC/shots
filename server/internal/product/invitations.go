package product

import (
	"context"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/invitation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/google/uuid"
)

type InvitationDetail struct {
	WorkspaceInvitation
	OrganizationID string `json:"organizationId"`
	InviterID      string `json:"inviterId"`
	Organization   struct {
		Name string `json:"name"`
	} `json:"organization"`
	User struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
}

func (c *Configuration) invitationRateLimit(ctx context.Context, actor Actor, action, invitationID string, limit int) error {
	where := []predicate.AuditLog{
		auditlog.OrganizationID(actor.OrganizationID), auditlog.ActorUserID(actor.UserID),
		auditlog.Action(action), auditlog.CreatedAtGTE(time.Now().UTC().Add(-time.Hour)),
	}
	if invitationID != "" {
		where = append(where, auditlog.EntityID(invitationID))
	}
	count, err := c.client.AuditLog.Query().Where(where...).Count(ctx)
	if err != nil {
		return err
	}
	if count >= limit {
		return ErrRateLimited
	}
	return nil
}

func (c *Configuration) invitationDetail(ctx context.Context, tx *ent.Tx, item *ent.Invitation) (*InvitationDetail, error) {
	org, err := tx.Organization.Get(ctx, item.OrganizationID)
	if err != nil {
		return nil, err
	}
	inviter, err := tx.User.Get(ctx, item.InviterID)
	if err != nil {
		return nil, err
	}
	detail := &InvitationDetail{WorkspaceInvitation: WorkspaceInvitation{
		CreatedAt: item.CreatedAt, Email: item.Email, ExpiresAt: item.ExpiresAt,
		ID: item.ID, Role: item.Role, Status: item.Status,
	}}
	detail.OrganizationID, detail.InviterID = org.ID, item.InviterID
	detail.Organization.Name = org.Name
	detail.User.Email, detail.User.Name = inviter.Email, inviter.Name
	return detail, nil
}

func (c *Configuration) sendInvitation(ctx context.Context, detail *InvitationDetail) {
	if c.invitations == nil {
		slog.Error("workspace invitation mailer is unavailable", "invitationId", detail.ID)
		return
	}
	inviterName := detail.User.Name
	if inviterName == "" {
		inviterName = detail.User.Email
	}
	if err := c.invitations.SendInvitation(ctx, InvitationMessage{
		Email: detail.Email, InvitationID: detail.ID,
		InviterName: inviterName, OrganizationName: detail.Organization.Name,
	}); err != nil {
		slog.Error("workspace invitation email delivery failed", "invitationId", detail.ID, "error", err)
	}
}

func (c *Configuration) InviteMember(ctx context.Context, actor Actor, email, role string) (*InvitationDetail, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	address, err := mail.ParseAddress(email)
	if err != nil || address.Address != email || len(email) > 320 || !ValidAssignableRole(role) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "member:invite"); err != nil {
		return nil, err
	}
	locked := NewConfiguration(tx.Client())
	if err := locked.invitationRateLimit(ctx, actor, "product.member_invited", "", 10); err != nil {
		return nil, err
	}
	if err := locked.RequireSeat(ctx, actor.OrganizationID, true); err != nil {
		return nil, err
	}
	person, err := tx.User.Query().Where(user.Email(email)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if person != nil {
		exists, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(person.ID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if exists {
			return nil, conflict("This user is already a workspace member.")
		}
	}
	if _, err := tx.Invitation.Update().Where(invitation.OrganizationID(actor.OrganizationID),
		invitation.Email(email), invitation.Status("pending"), invitation.ExpiresAtLTE(time.Now().UTC())).
		SetStatus("expired").Save(ctx); err != nil {
		return nil, err
	}
	exists, err := tx.Invitation.Query().Where(invitation.OrganizationID(actor.OrganizationID),
		invitation.Email(email), invitation.Status("pending")).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, conflict("This email already has a pending invitation.")
	}
	created, err := tx.Invitation.Create().SetID(uuid.NewString()).SetOrganizationID(actor.OrganizationID).
		SetEmail(email).SetRole(role).SetStatus("pending").SetInviterID(actor.UserID).
		SetExpiresAt(time.Now().UTC().Add(7 * 24 * time.Hour)).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This email already has a pending invitation.")
	}
	if err != nil {
		return nil, err
	}
	detail, err := c.invitationDetail(ctx, tx, created)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "invitation.created", "product.member_invited", "invitation", created.ID,
		map[string]any{"role": role}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.sendInvitation(ctx, detail)
	return detail, nil
}

func (c *Configuration) ResendInvitation(ctx context.Context, actor Actor, invitationID string) (*InvitationDetail, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "member:invite"); err != nil {
		return nil, err
	}
	if err := NewConfiguration(tx.Client()).invitationRateLimit(ctx, actor, "product.member_invitation_resent", invitationID, 3); err != nil {
		return nil, err
	}
	count, err := tx.Invitation.Update().Where(invitation.ID(invitationID), invitation.OrganizationID(actor.OrganizationID),
		invitation.Status("pending"), invitation.ExpiresAtGT(time.Now().UTC())).
		SetExpiresAt(time.Now().UTC().Add(7 * 24 * time.Hour)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, notFound("Pending invitation not found.")
	}
	updated, err := tx.Invitation.Get(ctx, invitationID)
	if err != nil {
		return nil, err
	}
	detail, err := c.invitationDetail(ctx, tx, updated)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.member_invitation_resent", "invitation", invitationID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.sendInvitation(ctx, detail)
	return detail, nil
}

// CancelInvitation returns the canonical canceled invitation to Better Auth.
// Existing product callers use RevokeInvitation, which shares this transaction.
func (c *Configuration) CancelInvitation(ctx context.Context, actor Actor, invitationID string) (*RecipientInvitation, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "invitation:revoke"); err != nil {
		return nil, err
	}
	count, err := tx.Invitation.Update().Where(invitation.ID(invitationID), invitation.OrganizationID(actor.OrganizationID),
		invitation.Status("pending")).SetStatus("canceled").Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, notFound("Pending invitation not found.")
	}
	if err := recordProductActivity(ctx, tx, actor, "invitation.revoked", "product.member_invitation_revoked", "invitation", invitationID); err != nil {
		return nil, err
	}
	item, err := tx.Invitation.Get(ctx, invitationID)
	if err != nil {
		return nil, err
	}
	result, err := recipientInvitationRecord(ctx, tx.Client(), item)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Configuration) RevokeInvitation(ctx context.Context, actor Actor, invitationID string) error {
	_, err := c.CancelInvitation(ctx, actor, invitationID)
	return err
}

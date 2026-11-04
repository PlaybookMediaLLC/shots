package product

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/invitation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
)

type MemberUser struct {
	Email string  `json:"email"`
	ID    string  `json:"id"`
	Image *string `json:"image"`
	Name  string  `json:"name"`
}

type WorkspaceMember struct {
	CreatedAt      time.Time  `json:"createdAt"`
	ID             string     `json:"id"`
	OrganizationID string     `json:"organizationId"`
	UserID         string     `json:"userId"`
	Role           string     `json:"role"`
	User           MemberUser `json:"user"`
}

func (c *Configuration) ListMembers(ctx context.Context, organizationID string) ([]WorkspaceMember, error) {
	members, err := c.client.Member.Query().Where(member.OrganizationID(organizationID)).
		Order(ent.Asc(member.FieldRole), ent.Asc(member.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]WorkspaceMember, 0, len(members))
	for _, membership := range members {
		person, err := c.client.User.Get(ctx, membership.UserID)
		if err != nil {
			return nil, err
		}
		items = append(items, *workspaceMemberRecord(membership, person))
	}
	return items, nil
}

type WorkspaceInvitation struct {
	CreatedAt time.Time `json:"createdAt"`
	Email     string    `json:"email"`
	ExpiresAt time.Time `json:"expiresAt"`
	ID        string    `json:"id"`
	Role      *string   `json:"role"`
	Status    string    `json:"status"`
}

func (c *Configuration) ListInvitations(ctx context.Context, organizationID string) ([]WorkspaceInvitation, error) {
	now := time.Now().UTC()
	if _, err := c.client.Invitation.Update().Where(
		invitation.OrganizationID(organizationID), invitation.Status("pending"), invitation.ExpiresAtLTE(now),
	).SetStatus("expired").Save(ctx); err != nil {
		return nil, err
	}
	invitations, err := c.client.Invitation.Query().Where(
		invitation.OrganizationID(organizationID), invitation.Status("pending"),
	).Order(ent.Desc(invitation.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]WorkspaceInvitation, 0, len(invitations))
	for _, item := range invitations {
		role := item.Role
		if role != nil && *role == "member" {
			viewer := "viewer"
			role = &viewer
		}
		items = append(items, WorkspaceInvitation{
			CreatedAt: item.CreatedAt, Email: item.Email, ExpiresAt: item.ExpiresAt,
			ID: item.ID, Role: role, Status: item.Status,
		})
	}
	return items, nil
}

func ValidAssignableRole(role string) bool {
	switch role {
	case "admin", "creator", "approver", "publisher", "writer_publisher", "viewer":
		return true
	default:
		return false
	}
}

func (c *Configuration) UpdateMemberRole(ctx context.Context, actor Actor, memberID, role string) (*WorkspaceMember, error) {
	if !ValidAssignableRole(role) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "member:update_role"); err != nil {
		return nil, err
	}
	if _, err = tx.PlatformExec(ctx, `SELECT set_config('platform.membership_explicit','true',true)`); err != nil {
		return nil, err
	}

	if _, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, memberID, actor.OrganizationID); err != nil {
		return nil, err
	}
	current, err := tx.Member.Query().Where(member.ID(memberID), member.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Member not found.")
	}
	if err != nil {
		return nil, err
	}
	if current.Role == "owner" {
		return nil, conflict("Use ownership transfer to change an owner role.")
	}
	count, err := tx.Member.Update().Where(member.ID(memberID), member.OrganizationID(actor.OrganizationID),
		member.RoleNEQ("owner")).SetRole(role).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, conflict("Member role changed. Please retry.")
	}
	updated, err := tx.Member.Get(ctx, memberID)
	if err != nil {
		return nil, err
	}
	person, err := tx.User.Get(ctx, updated.UserID)
	if err != nil {
		return nil, err
	}
	if current.Role != role {
		if err := recordProductActivity(ctx, tx, actor, "member.role_changed", "product.member_role_changed", "member", memberID,
			map[string]any{"role": role, "affectedUserId": current.UserID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.collabAccessChanged(ctx, actor.OrganizationID)
	return workspaceMemberRecord(updated, person), nil
}

func (c *Configuration) RemoveMember(ctx context.Context, actor Actor, memberID string) (*WorkspaceMember, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "member:remove"); err != nil {
		return nil, err
	}
	if _, err = tx.PlatformExec(ctx, `SELECT set_config('platform.membership_explicit','true',true)`); err != nil {
		return nil, err
	}

	if _, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, memberID, actor.OrganizationID); err != nil {
		return nil, err
	}
	current, err := tx.Member.Query().Where(member.ID(memberID), member.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Member not found.")
	}
	if err != nil {
		return nil, err
	}
	if current.Role == "owner" {
		return nil, conflict("Transfer ownership before removing an owner.")
	}
	if current.UserID == actor.UserID {
		return nil, invalid("Use leave workspace to remove yourself.")
	}
	person, err := tx.User.Get(ctx, current.UserID)
	if err != nil {
		return nil, err
	}
	count, err := tx.Member.Delete().Where(member.ID(memberID), member.OrganizationID(actor.OrganizationID),
		member.RoleNEQ("owner")).Exec(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, conflict("Member role changed. Please retry.")
	}
	if _, err := tx.Session.Delete().Where(session.ActiveOrganizationID(actor.OrganizationID), session.UserID(current.UserID)).Exec(ctx); err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "member.removed", "product.member_removed", "member", memberID); err != nil {
		return nil, err
	}
	result := workspaceMemberRecord(current, person)
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.collabAccessChanged(ctx, actor.OrganizationID)
	return result, nil
}

func (c *Configuration) LeaveWorkspace(ctx context.Context, actor Actor) (*WorkspaceMember, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := lockWorkspaceMembership(ctx, tx, actor); err != nil {
		return nil, err
	}
	if err := NewConfiguration(tx.Client()).AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if _, err = tx.PlatformExec(ctx, `SELECT set_config('platform.membership_explicit','true',true)`); err != nil {
		return nil, err
	}

	current, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, forbidden("Workspace membership not found.")
	}
	if err != nil {
		return nil, err
	}
	if current.Role == "owner" {
		return nil, conflict("Transfer ownership before leaving this workspace.")
	}
	person, err := tx.User.Get(ctx, current.UserID)
	if err != nil {
		return nil, err
	}
	count, err := tx.Member.Delete().Where(member.ID(current.ID), member.RoleNEQ("owner")).Exec(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, conflict("Member role changed. Please retry.")
	}
	if _, err := tx.Session.Delete().Where(session.ActiveOrganizationID(actor.OrganizationID), session.UserID(actor.UserID)).Exec(ctx); err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "member.left", "product.member_left", "member", current.ID); err != nil {
		return nil, err
	}
	result := workspaceMemberRecord(current, person)
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.collabAccessChanged(ctx, actor.OrganizationID)
	return result, nil
}

func (c *Configuration) TransferOwnership(ctx context.Context, actor Actor, memberID string) error {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := lockWorkspaceMembership(ctx, tx, actor); err != nil {
		return err
	}
	if err := NewConfiguration(tx.Client()).AuthorizeSensitive(ctx, actor); err != nil {
		return err
	}
	if _, err = tx.PlatformExec(ctx, `SELECT set_config('platform.membership_explicit','true',true)`); err != nil {
		return err
	}

	requester, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) || (err == nil && requester.Role != "owner") {
		return forbidden("Only the workspace owner can transfer ownership.")
	}
	if err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, memberID, actor.OrganizationID); err != nil {
		return err
	}
	recipient, err := tx.Member.Query().Where(member.ID(memberID), member.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return notFound("Member not found.")
	}
	if err != nil {
		return err
	}
	if recipient.ID == requester.ID {
		return invalid("Choose another workspace member.")
	}
	if recipient.Role == "owner" {
		return conflict("This member is already an owner.")
	}
	count, err := tx.Member.Update().Where(member.ID(requester.ID), member.Role("owner")).SetRole("admin").Save(ctx)
	if err != nil {
		return err
	}
	if count != 1 {
		return conflict("Member role changed. Please retry.")
	}
	count, err = tx.Member.Update().Where(member.ID(recipient.ID), member.OrganizationID(actor.OrganizationID),
		member.RoleNEQ("owner")).SetRole("owner").Save(ctx)
	if err != nil {
		return err
	}
	if count != 1 {
		return conflict("Member role changed. Please retry.")
	}
	if err := recordProductActivity(ctx, tx, actor, "workspace.ownership_transferred", "product.workspace_ownership_transferred", "member", memberID, map[string]any{"affectedUserId": recipient.UserID}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	c.collabAccessChanged(ctx, actor.OrganizationID)
	return nil
}

func workspaceMemberRecord(membership *ent.Member, person *ent.User) *WorkspaceMember {
	role := membership.Role
	if role == "member" {
		role = "viewer"
	}
	return &WorkspaceMember{
		CreatedAt: membership.CreatedAt, ID: membership.ID, OrganizationID: membership.OrganizationID, UserID: membership.UserID, Role: role,
		User: MemberUser{Email: person.Email, ID: person.ID, Image: person.Image, Name: person.Name},
	}
}

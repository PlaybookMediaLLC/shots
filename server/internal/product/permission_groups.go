package product

import (
	"context"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroup"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroupmember"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
	"github.com/lucsky/cuid"
)

// PermissionGroupsFeature is the plan feature that lets an organization
// restrict its members with permission groups.
const PermissionGroupsFeature = "enterprise:permission-groups"

type PermissionGroupRecord struct {
	CreatedAt         time.Time `json:"createdAt"`
	DeniedPermissions []string  `json:"deniedPermissions"`
	ID                string    `json:"id"`
	IsDefault         bool      `json:"isDefault"`
	MemberIDs         []string  `json:"memberIds"`
	Name              string    `json:"name"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type PermissionGroupInput struct {
	DeniedPermissions []string `json:"deniedPermissions"`
	IsDefault         bool     `json:"isDefault"`
	Name              string   `json:"name"`
}

// deniedPermissions is what a member's permission group subtracts from their
// role: their assigned group's, else the workspace default's. An owner is never
// restricted, so a workspace cannot lock itself out. It keeps applying after a
// plan lapses, since dropping it would silently widen access; an admin can
// delete a group on any plan.
func deniedPermissions(ctx context.Context, client *ent.Client, organizationID, userID, role string) ([]string, error) {
	if role == "owner" {
		return []string{}, nil
	}
	groups, err := client.PermissionGroup.Query().Where(permissiongroup.OrganizationID(organizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(groups) == 0 {
		return []string{}, nil
	}
	row, err := client.Member.Query().Where(member.OrganizationID(organizationID), member.UserID(userID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	assignment, err := client.PermissionGroupMember.Get(ctx, row.ID)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	for _, group := range groups {
		if (assignment != nil && group.ID == assignment.PermissionGroupID) || (assignment == nil && group.IsDefault) {
			return group.DeniedPermissions, nil
		}
	}
	return []string{}, nil
}

// requireNotDenied refuses a member whose permission group denies permission.
// The web checks this on its routes; member commands also arrive through the
// Better Auth endpoints, which reach the backend without that check. Only a
// person can be in a group, so other callers pass.
func requireNotDenied(ctx context.Context, client *ent.Client, actor Actor, permission string) error {
	if !actor.IsSession() {
		return nil
	}
	row, err := client.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(actor.UserID)).Only(ctx)
	if err != nil {
		return err
	}
	denied, err := deniedPermissions(ctx, client, actor.OrganizationID, actor.UserID, row.Role)
	if err != nil {
		return err
	}
	if slices.Contains(denied, permission) {
		return publishing.ErrForbidden
	}
	return nil
}

// sortedUnique copies values, since Compact overwrites the slice it is given.
func sortedUnique(values []string) []string {
	unique := append([]string{}, values...)
	slices.Sort(unique)
	return slices.Compact(unique)
}

func (input *PermissionGroupInput) normalize() bool {
	input.Name = strings.TrimSpace(input.Name)
	input.DeniedPermissions = sortedUnique(input.DeniedPermissions)
	return input.Name != "" && utf8.RuneCountInString(input.Name) <= 100 &&
		!slices.ContainsFunc(input.DeniedPermissions, func(name string) bool { return !workspaceroles.ValidPermission(name) })
}

// ListPermissionGroups returns the workspace's groups and their members.
func (c *Configuration) ListPermissionGroups(ctx context.Context, actor Actor) ([]PermissionGroupRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	groups, err := c.client.PermissionGroup.Query().Where(permissiongroup.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(permissiongroup.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]PermissionGroupRecord, 0, len(groups))
	for _, group := range groups {
		memberIDs, err := c.client.PermissionGroupMember.Query().Where(permissiongroupmember.PermissionGroupID(group.ID)).IDs(ctx)
		if err != nil {
			return nil, err
		}
		records = append(records, permissionGroupRecord(group, memberIDs))
	}
	return records, nil
}

func permissionGroupRecord(group *ent.PermissionGroup, memberIDs []string) PermissionGroupRecord {
	if memberIDs == nil {
		memberIDs = []string{}
	}
	return PermissionGroupRecord{CreatedAt: group.CreatedAt, DeniedPermissions: group.DeniedPermissions, ID: group.ID,
		IsDefault: group.IsDefault, MemberIDs: memberIDs, Name: group.Name, UpdatedAt: group.UpdatedAt}
}

func (c *Configuration) authorizePermissionGroupChange(ctx context.Context, actor Actor) error {
	if err := c.authorizeAuditManage(ctx, actor); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, PermissionGroupsFeature)
}

func auditPermissionGroup(ctx context.Context, tx *ent.Tx, actor Actor, request AuditRequest, action, groupID string, metadata map[string]any) error {
	return appendRequestAudit(ctx, tx, actor, request, "permission_group."+action, "permission_group", groupID, metadata)
}

// CreatePermissionGroup adds a group with no assigned members.
func (c *Configuration) CreatePermissionGroup(ctx context.Context, actor Actor, input PermissionGroupInput, request AuditRequest) (*PermissionGroupRecord, error) {
	if err := c.authorizePermissionGroupChange(ctx, actor); err != nil {
		return nil, err
	}
	if !input.normalize() {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	group, err := tx.PermissionGroup.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(input.Name).
		SetDeniedPermissions(input.DeniedPermissions).SetIsDefault(input.IsDefault).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := auditPermissionGroup(ctx, tx, actor, request, "created", group.ID, map[string]any{
		"deniedPermissions": input.DeniedPermissions, "isDefault": input.IsDefault, "name": input.Name}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := permissionGroupRecord(group, nil)
	return &record, nil
}

func ownedPermissionGroup(ctx context.Context, tx *ent.Tx, actor Actor, id string) (*ent.PermissionGroup, error) {
	group, err := tx.PermissionGroup.Query().Where(permissiongroup.ID(id), permissiongroup.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return group, err
}

// UpdatePermissionGroup replaces a group's name, permissions and default flag.
func (c *Configuration) UpdatePermissionGroup(ctx context.Context, actor Actor, id string, input PermissionGroupInput, request AuditRequest) (*PermissionGroupRecord, error) {
	if err := c.authorizePermissionGroupChange(ctx, actor); err != nil {
		return nil, err
	}
	if !input.normalize() {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := ownedPermissionGroup(ctx, tx, actor, id); err != nil {
		return nil, err
	}
	group, err := tx.PermissionGroup.UpdateOneID(id).SetName(input.Name).
		SetDeniedPermissions(input.DeniedPermissions).SetIsDefault(input.IsDefault).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	memberIDs, err := tx.PermissionGroupMember.Query().Where(permissiongroupmember.PermissionGroupID(id)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	if err := auditPermissionGroup(ctx, tx, actor, request, "updated", id, map[string]any{
		"deniedPermissions": input.DeniedPermissions, "isDefault": input.IsDefault, "name": input.Name}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := permissionGroupRecord(group, memberIDs)
	return &record, nil
}

// DeletePermissionGroup lifts a group's restrictions. It needs no plan feature,
// so a workspace whose plan lapsed can still remove them.
func (c *Configuration) DeletePermissionGroup(ctx context.Context, actor Actor, id string, request AuditRequest) error {
	if err := c.authorizeAuditManage(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	group, err := ownedPermissionGroup(ctx, tx, actor, id)
	if err != nil {
		return err
	}
	if err := tx.PermissionGroup.DeleteOneID(id).Exec(ctx); err != nil {
		return err
	}
	if err := auditPermissionGroup(ctx, tx, actor, request, "deleted", id, map[string]any{"name": group.Name}); err != nil {
		return err
	}
	return tx.Commit()
}

// SetPermissionGroupMembers makes memberIDs exactly the group's members, moving
// anyone assigned to another group. Every ID must be a member of this workspace.
func (c *Configuration) SetPermissionGroupMembers(ctx context.Context, actor Actor, id string, memberIDs []string, request AuditRequest) (*PermissionGroupRecord, error) {
	if err := c.authorizePermissionGroupChange(ctx, actor); err != nil {
		return nil, err
	}
	memberIDs = sortedUnique(memberIDs)
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	group, err := ownedPermissionGroup(ctx, tx, actor, id)
	if err != nil {
		return nil, err
	}
	known, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.IDIn(memberIDs...)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if known != len(memberIDs) {
		return nil, ErrInvalidInput
	}
	if _, err := tx.PermissionGroupMember.Delete().Where(permissiongroupmember.Or(
		permissiongroupmember.PermissionGroupID(id), permissiongroupmember.IDIn(memberIDs...))).Exec(ctx); err != nil {
		return nil, err
	}
	for _, memberID := range memberIDs {
		if err := tx.PermissionGroupMember.Create().SetID(memberID).SetPermissionGroupID(id).Exec(ctx); err != nil {
			return nil, err
		}
	}
	if err := auditPermissionGroup(ctx, tx, actor, request, "members_changed", id, map[string]any{"memberIds": memberIDs}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := permissionGroupRecord(group, memberIDs)
	return &record, nil
}

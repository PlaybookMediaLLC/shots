package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PermissionGroup subtracts permissions from its members' roles. It only ever
// restricts, and never restricts an owner. A default group covers every member
// not assigned to another group, however they joined (invitation, SSO, SCIM).
type PermissionGroup struct{ ent.Schema }

func (PermissionGroup) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "permission_group"}}
}
func (PermissionGroup) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("name").StorageKey("name"),
		field.JSON("denied_permissions", []string{}).StorageKey("deniedPermissions"),
		field.Bool("is_default").StorageKey("isDefault").Default(false),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (PermissionGroup) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "name").Unique()}
}

// PermissionGroupMember assigns a member to a group. Keying it by the member
// allows one group per member and removes it when the member leaves.
type PermissionGroupMember struct{ ent.Schema }

func (PermissionGroupMember) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "permission_group_member"}}
}
func (PermissionGroupMember) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("memberId").Immutable(),
		field.String("permission_group_id").StorageKey("permissionGroupId"),
	}
}
func (PermissionGroupMember) Indexes() []ent.Index {
	return []ent.Index{index.Fields("permission_group_id")}
}

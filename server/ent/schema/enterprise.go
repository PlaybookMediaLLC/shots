package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
)

// SupportAccessGrant is the authorization projection for a time-bound grant.
type SupportAccessGrant struct{ ent.Schema }

func (SupportAccessGrant) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "support_access_grant"}}
}
func (SupportAccessGrant) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("scope").StorageKey("scope").Default("metadata:read"),
		field.String("purpose").StorageKey("purpose"),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("revoked_at").StorageKey("revokedAt").Optional().Nillable(),
	}
}
func (SupportAccessGrant) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "expires_at"), index.Fields("user_id", "expires_at")}
}

// OrganizationEnterpriseSettings controls enterprise identity features and
// the organization's white-label branding.
type OrganizationEnterpriseSettings struct{ ent.Schema }

func (OrganizationEnterpriseSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "organization_enterprise_settings"}}
}
func (OrganizationEnterpriseSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.Bool("sso_enabled").StorageKey("ssoEnabled").Default(false),
		field.Bool("scim_enabled").StorageKey("scimEnabled").Default(false),
		field.JSON("whitelabel_settings", whitelabel.Settings{}).StorageKey("whitelabelSettings").Optional(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

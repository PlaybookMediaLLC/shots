package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ShareLink publishes one exported artifact (an image or a video, with an
// optional poster image) at an unguessable URL. Access is anyone with the
// link or workspace members only; a link can expire and can be revoked.
type ShareLink struct{ ent.Schema }

func (ShareLink) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "share_link"}}
}

func (ShareLink) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("token").StorageKey("token").Immutable(),
		field.String("asset_id").StorageKey("assetId").Immutable(),
		field.String("poster_asset_id").StorageKey("posterAssetId").Optional().Nillable().Immutable(),
		field.String("project_id").StorageKey("projectId").Optional().Nillable().Immutable(),
		field.String("title").StorageKey("title"),
		field.String("description").StorageKey("description").Optional().Nillable(),
		field.String("alt_text").StorageKey("altText").Optional().Nillable(),
		// A frozen Code Studio document (RFC 053) for a live, copyable code embed.
		field.JSON("code", map[string]any{}).StorageKey("code").Optional().Immutable(),
		field.Enum("access").StorageKey("access").Values("PUBLIC", "WORKSPACE").Default("PUBLIC"),
		field.Time("expires_at").StorageKey("expiresAt").Optional().Nillable(),
		field.Time("revoked_at").StorageKey("revokedAt").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ShareLink) Indexes() []ent.Index {
	return []ent.Index{index.Fields("token").Unique(), index.Fields("organization_id", "created_at")}
}

// IntegrationConnection is a workspace's connection to Slack, Notion, or
// Figma. Credentials arrive encrypted by the web facade, which alone holds
// the key, and are only returned to it.
type IntegrationConnection struct{ ent.Schema }

func (IntegrationConnection) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "integration_connection"}}
}

func (IntegrationConnection) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		// SENJA holds a workspace's own Senja API key, for importing testimonials.
		field.Enum("provider").StorageKey("provider").Values("SLACK", "NOTION", "FIGMA", "SENJA").Immutable(),
		field.String("external_id").StorageKey("externalId").Immutable(),
		field.String("display_name").StorageKey("displayName"),
		field.String("encrypted_credentials").StorageKey("encryptedCredentials").Sensitive(),
		field.JSON("scopes", []string{}).StorageKey("scopes").Default([]string{}),
		field.Time("token_expires_at").StorageKey("tokenExpiresAt").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (IntegrationConnection) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "provider", "external_id").Unique()}
}

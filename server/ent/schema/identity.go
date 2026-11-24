package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// These identity models project the existing Better Auth rows while the web
// sign-in implementation is moved behind the backend. The backend independently
// checks the session and membership for every publishing API request.
type User struct{ ent.Schema }

func (User) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "user"}}
}
func (User) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("name").StorageKey("name"),
		field.String("email").StorageKey("email"),
		field.String("image").StorageKey("image").Optional().Nillable(),
		field.Bool("email_verified").StorageKey("emailVerified").Default(false),
		field.Bool("two_factor_enabled").StorageKey("twoFactorEnabled").Optional().Nillable(),
		field.Bool("banned").StorageKey("banned").Optional().Nillable(),
		field.Time("ban_expires").StorageKey("banExpires").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (User) Indexes() []ent.Index { return []ent.Index{index.Fields("email").Unique()} }

type Session struct{ ent.Schema }

func (Session) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "session"}}
}
func (Session) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("token").StorageKey("token").Sensitive(),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.String("active_organization_id").StorageKey("activeOrganizationId").Optional().Nillable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (Session) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id"), index.Fields("token").Unique()}
}

type Organization struct{ ent.Schema }

func (Organization) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "organization"}}
}
func (Organization) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("name").StorageKey("name"),
		field.String("slug").StorageKey("slug"),
		field.String("logo").StorageKey("logo").Optional().Nillable(),
		field.String("metadata").StorageKey("metadata").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (Organization) Indexes() []ent.Index { return []ent.Index{index.Fields("slug").Unique()} }

type Member struct{ ent.Schema }

func (Member) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "member"}}
}
func (Member) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("role").StorageKey("role").Default("member"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (Member) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "user_id").Unique(),
		index.Fields("organization_id"), index.Fields("user_id"),
	}
}

type Invitation struct{ ent.Schema }

func (Invitation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "invitation"}}
}
func (Invitation) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("email").StorageKey("email"),
		field.String("role").StorageKey("role").Optional().Nillable(),
		field.String("status").StorageKey("status").Default("pending"),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.String("inviter_id").StorageKey("inviterId").Immutable(),
	}
}
func (Invitation) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id"), index.Fields("email"), index.Fields("organization_id", "status", "created_at")}
}

type WorkspaceSettings struct{ ent.Schema }

func (WorkspaceSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "workspace_settings"}}
}
func (WorkspaceSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.String("description").StorageKey("description").Optional().Nillable(),
		field.String("locale").StorageKey("locale").Default("en"),
		field.String("time_zone").StorageKey("timeZone").Default("UTC"),
		field.String("default_publish_time").StorageKey("defaultPublishTime").Default("09:00"),
		// The workspace AI agent kill switch (docs/rfcs/027-ai-sdk-marketing-tools.md).
		field.Bool("ai_agent_enabled").StorageKey("aiAgentEnabled").Default(true),
		// Manual release qualification is enabled explicitly for a workspace.
		field.Bool("release_readiness_enabled").StorageKey("releaseReadinessEnabled").Default(false),
		// Experiments an owner or admin turned off for everyone (RFC 024).
		field.JSON("disabled_experiments", []string{}).StorageKey("disabledExperiments").Default([]string{}),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

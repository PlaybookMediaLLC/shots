package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"github.com/google/uuid"
)

type PlatformFounderHubUser struct{ ent.Schema }

func (PlatformFounderHubUser) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_user"}}
}
func (PlatformFounderHubUser) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("userId").Immutable(),
		field.UUID("account_user_id", uuid.UUID{}).StorageKey("accountUserId").Unique().Immutable(),
		field.Bool("templates_initialized").StorageKey("templatesInitialized").Default(false),
	}
}

type PlatformFounderHubWorkspace struct{ ent.Schema }

func (PlatformFounderHubWorkspace) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_workspace"}}
}
func (PlatformFounderHubWorkspace) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.UUID("workspace_id", uuid.UUID{}).StorageKey("workspaceId").Unique().Immutable(),
	}
}

type PlatformFounderHubRevision struct{ ent.Schema }

func (PlatformFounderHubRevision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_revision"}}
}
func (PlatformFounderHubRevision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.Int64("revision").Default(0),
	}
}

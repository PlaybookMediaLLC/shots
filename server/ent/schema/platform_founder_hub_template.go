package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"time"
)

type PlatformFounderHubTemplate struct{ ent.Schema }

func (PlatformFounderHubTemplate) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_template"}}
}

func (PlatformFounderHubTemplate) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("template_id").StorageKey("templateId").Immutable(),
		field.JSON("content", founderhub.TemplateContent{}),
		field.Bool("pinned").Default(false),
		field.Bool("seeded").Default(false),
		field.Int("pin_order").StorageKey("pinOrder").Optional().Nillable(),
		field.Int("version").Default(1),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now),
		field.Time("deleted_at").StorageKey("deletedAt").Optional().Nillable(),
	}
}

func (PlatformFounderHubTemplate) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id", "template_id").Unique()}
}

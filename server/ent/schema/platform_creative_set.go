package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PlatformCreativeSet is a saved editor composition a workspace keeps working on. Every
// document write bumps revision, so a writer holding an older revision is
// refused instead of overwriting newer work.
type PlatformCreativeSet struct{ ent.Schema }

func (PlatformCreativeSet) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_creative_set"}}
}

func (PlatformCreativeSet) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("name").StorageKey("name"),
		// A canvas workspace (RFC 032), a Story Set or a store screenshot project; a row never changes kind.
		field.Enum("kind").StorageKey("kind").NamedValues("StorySet", "story-set", "Canvas", "canvas", "Store", "store").Default("story-set").Immutable(),
		field.JSON("document", map[string]any{}).StorageKey("document"),
		field.Int("document_version").StorageKey("documentVersion"),
		field.Int("revision").StorageKey("revision").Default(1),
		field.Bool("archived").Default(false),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable(),
		field.String("updated_by_user_id").StorageKey("updatedByUserId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (PlatformCreativeSet) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "updated_at"), index.Fields("organization_id", "kind", "updated_at")}
}

// PlatformCreativeSetVersion is a snapshot of a project's document: an autosave
// checkpoint, a version the user named, a restore, or a duplicate's origin.
type PlatformCreativeSetVersion struct{ ent.Schema }

func (PlatformCreativeSetVersion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_creative_set_version"}}
}

func (PlatformCreativeSetVersion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("creative_set_id").StorageKey("creativeSetId").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Int("revision").StorageKey("revision").Immutable(),
		field.Enum("kind").StorageKey("kind").Values("autosave", "named", "restore", "duplicate").Immutable(),
		field.String("name").StorageKey("name").Optional().Nillable(),
		field.JSON("document", map[string]any{}).StorageKey("document").Immutable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (PlatformCreativeSetVersion) Indexes() []ent.Index {
	return []ent.Index{index.Fields("creative_set_id", "created_at")}
}

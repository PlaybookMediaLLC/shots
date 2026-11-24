package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

// Release is the canonical product brief in the shared public schema.
type Release struct{ ent.Schema }

func (Release) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "release"}}
}

func (Release) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("title").StorageKey("title"),
		field.String("benefit_statement").StorageKey("benefitStatement"),
		field.String("description").StorageKey("description").Optional().Nillable(),
		field.String("audience").StorageKey("audience").Optional().Nillable(),
		field.JSON("source_urls", []string{}).StorageKey("sourceUrls").Default([]string{}),
		// The full release notes a source sent, cleaned; the brief keeps their opening.
		field.String("notes").StorageKey("notes").Optional().Nillable(),
		field.JSON("features", []releasenotes.Feature{}).StorageKey("features").Default([]releasenotes.Feature{}),
		field.JSON("screenshot_asset_ids", []string{}).StorageKey("screenshotAssetIds").Default([]string{}),
		field.String("product_surface_id").StorageKey("productSurfaceId").Optional().Nillable(),
		field.Enum("status").StorageKey("status").Values("DRAFT", "READY", "ARCHIVED", "CANCELLED").Default("DRAFT"),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (Release) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "status", "updated_at"),
		index.Fields("organization_id", "created_at"),
		index.Fields("organization_id", "product_surface_id"),
	}
}

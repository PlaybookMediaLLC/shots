package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

type ProductSurface struct{ ent.Schema }

func (ProductSurface) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "product_surface"}}
}
func (ProductSurface) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("platform_owner_user_id").StorageKey("platformOwnerUserId").Optional().Nillable(),
		field.String("name").StorageKey("name"),
		// Stable and URL-safe, unique per workspace; set from the name at creation.
		field.String("slug").StorageKey("slug").Immutable(),
		field.String("url").StorageKey("url"),
		field.String("environment").StorageKey("environment").Default("production"),
		field.String("description").StorageKey("description").Optional().Nillable(),
		field.JSON("feature_tags", []string{}).StorageKey("featureTags"),
		// Compatibility copy of the newest captures (at most 50); surface_capture is the record.
		field.JSON("screenshot_asset_ids", []string{}).StorageKey("screenshotAssetIds"),
		field.Time("last_captured_at").StorageKey("lastCapturedAt").Optional().Nillable(),
		// Why the newest capture attempt failed; cleared by a successful capture.
		field.String("last_capture_failure_code").StorageKey("lastCaptureFailureCode").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (ProductSurface) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "name").Unique(), index.Fields("organization_id", "slug").Unique(),
		index.Fields("organization_id", "created_at")}
}

// SurfaceCapture is one screenshot of a product surface. A newer capture
// supersedes the current one; superseded captures stay readable so content
// built from them keeps its source (docs/rfcs/018-product-asset-map.md).
type SurfaceCapture struct{ ent.Schema }

func (SurfaceCapture) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "surface_capture"}}
}
func (SurfaceCapture) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("surface_id").StorageKey("surfaceId").Immutable(),
		field.String("asset_id").StorageKey("assetId").Immutable(),
		field.Enum("source").StorageKey("source").Values("deployment", "agent", "release", "manual").Immutable(),
		// The deployment event, release, or run that produced the capture.
		field.String("source_id").StorageKey("sourceId").Optional().Nillable().Immutable(),
		field.Time("captured_at").StorageKey("capturedAt").Default(time.Now).Immutable(),
		field.Time("superseded_at").StorageKey("supersededAt").Optional().Nillable(),
		// ObservedRevision is the commit the app reported just before this capture.
		field.String("observed_revision").StorageKey("observedRevision").Optional().Nillable().Immutable(),
	}
}
func (SurfaceCapture) Indexes() []ent.Index {
	return []ent.Index{index.Fields("surface_id", "captured_at"), index.Fields("organization_id", "captured_at")}
}

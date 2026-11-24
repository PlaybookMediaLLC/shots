package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"time"
)

// CreativeVariant is a read-only projection of the application-owned table.
type CreativeVariant struct{ ent.Schema }

func (CreativeVariant) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "creative_variant"}}
}
func (CreativeVariant) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_asset_id").StorageKey("sourceAssetId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("brand_kit_id").StorageKey("brandKitId").Optional().Nillable().Immutable(),
		field.Int("brand_kit_version").StorageKey("brandKitVersion").Optional().Nillable().Immutable(),
		field.String("template_id").StorageKey("templateId").Optional().Nillable().Immutable(),
		field.Int("template_version").StorageKey("templateVersion").Optional().Nillable().Immutable(),
		field.String("design_id").StorageKey("designId").Optional().Nillable().Immutable(),
		field.Int("revision").StorageKey("revision").Immutable(),
		field.String("aspect_ratio").StorageKey("aspectRatio").Immutable(),
		field.Enum("status").StorageKey("status").Values("DRAFT", "APPROVED", "ARCHIVED"),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (CreativeVariant) Edges() []ent.Edge {
	return []ent.Edge{
		edge.To("source_asset", Asset.Type).Field("source_asset_id").Unique().Required().Immutable(),
		edge.To("approval", Approval.Type).Unique(),
	}
}
func (CreativeVariant) Indexes() []ent.Index {
	return []ent.Index{index.Fields("release_id", "aspect_ratio", "revision").Unique(),
		index.Fields("design_id", "source_asset_id").Unique(),
		index.Fields("organization_id", "created_at")}
}

// Approval is a read-only projection used to enforce approval at scheduling and dispatch.
type Approval struct{ ent.Schema }

func (Approval) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "approval"}}
}
func (Approval) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("variant_id").StorageKey("variantId").Immutable(),
		field.Enum("status").StorageKey("status").Values("PENDING", "APPROVED", "REJECTED"),
		field.String("decided_by_user_id").StorageKey("decidedByUserId").Optional().Nillable(),
		field.Time("decided_at").StorageKey("decidedAt").Optional().Nillable(),
		field.String("reason").StorageKey("reason").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (Approval) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("variant", CreativeVariant.Type).Ref("approval").Field("variant_id").Unique().Required().Immutable(),
	}
}
func (Approval) Indexes() []ent.Index {
	return []ent.Index{index.Fields("variant_id").Unique(), index.Fields("organization_id", "created_at")}
}

// Asset is the canonical media row shared by product and publishing.
type Asset struct{ ent.Schema }

func (Asset) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "asset"}}
}
func (Asset) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("capture_id").StorageKey("captureId").Optional().Nillable(),
		field.String("parent_asset_id").StorageKey("parentAssetId").Optional().Nillable(),
		field.String("object_key").StorageKey("objectKey").Immutable(),
		field.String("sha256").StorageKey("sha256").Optional().Nillable(),
		field.String("media_type").StorageKey("mediaType").Immutable(),
		field.Int("bytes").StorageKey("bytes"),
		field.Int("width").StorageKey("width").Optional().Nillable(),
		field.Int("height").StorageKey("height").Optional().Nillable(),
		// A video's length and sample entry codecs (avc1,mp4a), read from its
		// container when the upload completes; empty for other media and for
		// videos uploaded before scheduling checked them.
		field.Int("duration_ms").StorageKey("durationMs").Optional().Nillable(),
		field.String("codecs").StorageKey("codecs").Optional().Nillable(),
		// The storage multipart upload of a large file still being sent;
		// cleared once the server completes it.
		field.String("upload_id").StorageKey("uploadId").Optional().Nillable(),
		field.Enum("status").StorageKey("status").Values("PENDING", "UPLOADED", "FAILED", "DELETED").Default("PENDING"),
		// AltText describes an image for people who cannot see it (RFC 025);
		// it goes out with the image wherever it is posted.
		field.String("alt_text").StorageKey("altText").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (Asset) Edges() []ent.Edge {
	return []ent.Edge{edge.From("variants", CreativeVariant.Type).Ref("source_asset")}
}
func (Asset) Indexes() []ent.Index {
	return []ent.Index{index.Fields("object_key").Unique(), index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "created_at"), index.Fields("parent_asset_id")}
}

// WorkspaceDeletion is a read-only projection used to block publications during deletion.
type WorkspaceDeletion struct{ ent.Schema }

func (WorkspaceDeletion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "workspace_deletion"}}
}
func (WorkspaceDeletion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Enum("status").StorageKey("status").Values("PENDING", "PROCESSING", "CANCELLED", "PURGED"),
		field.String("requested_by_user_id").StorageKey("requestedByUserId"),
		field.Time("scheduled_for").StorageKey("scheduledFor"),
		field.Time("processing_at").StorageKey("processingAt").Optional().Nillable(),
		field.Time("cancelled_at").StorageKey("cancelledAt").Optional().Nillable(),
		field.Time("purged_at").StorageKey("purgedAt").Optional().Nillable(),
		field.String("last_error").StorageKey("lastError").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (WorkspaceDeletion) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id").Unique()}
}

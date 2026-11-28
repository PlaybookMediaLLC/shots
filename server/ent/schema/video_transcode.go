package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// VideoTranscodeJob tracks server-side video normalization/transcoding for a
// source workspace asset and target encoding profile. Originals are never
// mutated; completed jobs reference a derived Asset with parentAssetId set.
type VideoTranscodeJob struct{ ent.Schema }

func (VideoTranscodeJob) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "video_transcode_job"}}
}

func (VideoTranscodeJob) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_asset_id").StorageKey("sourceAssetId").Immutable(),
		field.String("profile_hash").StorageKey("profileHash").Immutable(),
		field.String("profile_name").StorageKey("profileName").Immutable(),
		field.Enum("status").StorageKey("status").Values("PENDING", "PROCESSING", "COMPLETED", "FAILED").Default("PENDING"),
		field.String("output_asset_id").StorageKey("outputAssetId").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.String("failure_message").StorageKey("failureMessage").Optional().Nillable(),
		field.Int("duration_ms").StorageKey("durationMs").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
		field.Time("completed_at").StorageKey("completedAt").Optional().Nillable(),
	}
}

func (VideoTranscodeJob) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "source_asset_id", "profile_hash"),
		index.Fields("organization_id", "status", "updated_at"),
	}
}

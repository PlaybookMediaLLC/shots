package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

// A provider object can retain evidence before it is selected for a release.
type ReleaseSourceBinding struct{ ent.Schema }

func (ReleaseSourceBinding) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_source_binding"}}
}

func (ReleaseSourceBinding) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Immutable(),
		field.String("provider").MaxLen(64).NotEmpty().Immutable(),
		field.Enum("object_kind").StorageKey("objectKind").Values(releasefacts.SourceKinds...).Immutable(),
		field.String("repository_id").StorageKey("repositoryId").MaxLen(128).Immutable(),
		field.String("provider_object_id").StorageKey("providerObjectId").MaxLen(200).NotEmpty().Immutable(),
		field.String("canonical_release_id").StorageKey("canonicalReleaseId").Optional().Nillable(),
		field.Int64("last_event_sequence").StorageKey("lastEventSequence").Default(0).NonNegative(),
		field.Int64("change_sequence").StorageKey("changeSequence").Default(0).NonNegative(),
		field.String("current_observation_id").StorageKey("currentObservationId").Optional().Nillable(),
		field.String("selected_observation_id").StorageKey("selectedObservationId").Optional().Nillable(),
		field.Int64("selected_change_sequence").StorageKey("selectedChangeSequence").Default(0).NonNegative(),
		field.Bool("needs_resolution").StorageKey("needsResolution").Default(false),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ReleaseSourceBinding) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "source_app_id", "object_kind", "repository_id", "provider_object_id").Unique(),
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "source_app_id", "id").Unique(),
		index.Fields("organization_id", "canonical_release_id", "updated_at", "id"),
	}
}

type ReleaseSourceObservation struct{ ent.Schema }

func (ReleaseSourceObservation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_source_observation"}}
}

func (ReleaseSourceObservation) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Immutable(),
		field.String("binding_id").StorageKey("bindingId").Immutable(),
		field.String("event_key").StorageKey("eventKey").MaxLen(512).NotEmpty().Immutable(),
		field.String("provider_event_id").StorageKey("providerEventId").MaxLen(255).Optional().Nillable().Immutable(),
		field.Int64("sequence").Positive().Immutable(),
		field.String("body_sha256").StorageKey("bodySha256").MaxLen(64).Immutable(),
		field.Time("source_updated_at").StorageKey("sourceUpdatedAt").Optional().Nillable().Immutable(),
		field.Time("occurred_at").StorageKey("occurredAt").Immutable(),
		field.Enum("origin").Values("LIVE", "HISTORICAL").Immutable(),
		field.Int("schema_version").StorageKey("schemaVersion").Default(1).Immutable(),
		field.JSON("snapshot", releasefacts.SourceSnapshot{}).Immutable(),
		field.Time("received_at").StorageKey("receivedAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseSourceObservation) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "source_app_id", "event_key").Unique(),
		index.Fields("organization_id", "binding_id", "sequence").Unique(),
		index.Fields("organization_id", "binding_id", "id").Unique(),
	}
}

// A retained observation is provider evidence, not an uploaded Asset.
type ReleaseQualificationSource struct{ ent.Schema }

func (ReleaseQualificationSource) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_qualification_source"}}
}

func (ReleaseQualificationSource) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("qualification_revision_id").StorageKey("qualificationRevisionId").Immutable(),
		field.String("binding_id").StorageKey("bindingId").Immutable(),
		field.String("observation_id").StorageKey("observationId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseQualificationSource) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "release_id", "qualification_revision_id", "binding_id").Unique(),
		index.Fields("organization_id", "binding_id", "observation_id"),
	}
}

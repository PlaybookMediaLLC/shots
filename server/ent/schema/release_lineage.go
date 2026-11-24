package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ReleaseLineage retains each explicit source-to-destination grouping decision.
type ReleaseLineage struct{ ent.Schema }

func (ReleaseLineage) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_lineage"}}
}

func (ReleaseLineage) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Enum("operation").Values("MERGE", "SPLIT").Immutable(),
		field.String("source_release_id").StorageKey("sourceReleaseId").Immutable(),
		field.String("destination_release_id").StorageKey("destinationReleaseId").Immutable(),
		field.Int64("source_revision").StorageKey("sourceRevision").Positive().Immutable(),
		field.Int64("destination_revision").StorageKey("destinationRevision").Positive().Immutable(),
		field.String("reason").NotEmpty().MaxLen(4000).Immutable(),
		field.String("human_user_id").StorageKey("humanUserId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseLineage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "source_release_id", "created_at", "id"),
		index.Fields("organization_id", "destination_release_id", "created_at", "id"),
	}
}

// Binding membership has same-tenant foreign keys instead of IDs hidden in JSON.
type ReleaseLineageBinding struct{ ent.Schema }

func (ReleaseLineageBinding) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_lineage_binding"}}
}

func (ReleaseLineageBinding) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("lineage_id").StorageKey("lineageId").Immutable(),
		field.String("binding_id").StorageKey("bindingId").Immutable(),
	}
}

func (ReleaseLineageBinding) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "lineage_id", "binding_id").Unique(),
		index.Fields("organization_id", "binding_id"),
	}
}

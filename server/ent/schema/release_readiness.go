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

type ReleaseReadiness struct{ ent.Schema }

func (ReleaseReadiness) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_readiness"}}
}

func (ReleaseReadiness) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.Int64("head_revision").StorageKey("headRevision").Default(0).NonNegative(),
		field.String("qualification_revision_id").StorageKey("qualificationRevisionId").Optional().Nillable(),
		field.Time("first_qualified_at").StorageKey("firstQualifiedAt").Optional().Nillable(),
		field.Enum("canonical_state").StorageKey("canonicalState").Values("ACTIVE", "MERGED", "WITHDRAWN").Default("ACTIVE"),
		field.String("merged_into_release_id").StorageKey("mergedIntoReleaseId").Optional().Nillable(),
		// A legacy factual edit invalidates the current decision without erasing it.
		field.Bool("needs_review").StorageKey("needsReview").Default(false),
		field.JSON("claim_import_progress", releasefacts.ClaimImportProgress{}).StorageKey("claimImportProgress").Optional(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ReleaseReadiness) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "release_id").Unique()}
}

type ReleaseQualification struct{ ent.Schema }

func (ReleaseQualification) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_qualification"}}
}

func (ReleaseQualification) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.Int64("version").Positive().Immutable(),
		field.Int64("aggregate_revision").StorageKey("aggregateRevision").Positive().Immutable(),
		field.String("parent_revision_id").StorageKey("parentRevisionId").Optional().Nillable().Immutable(),
		field.String("owner_user_id").StorageKey("ownerUserId").Optional().Nillable().Immutable(),
		field.String("fact_reviewer_user_id").StorageKey("factReviewerUserId").Optional().Nillable().Immutable(),
		field.String("rationale").Optional().Nillable().Immutable(),
		field.Enum("rollout").Values(releasefacts.Rollouts...).Immutable(),
		field.String("availability").Optional().Nillable().Immutable(),
		field.String("exclusions").Optional().Nillable().Immutable(),
		field.String("eligibility").Optional().Nillable().Immutable(),
		field.String("planned_availability").StorageKey("plannedAvailability").Optional().Nillable().Immutable(),
		field.Time("ready_at").StorageKey("readyAt").Optional().Nillable().Immutable(),
		field.String("human_brief").StorageKey("humanBrief").Optional().Nillable().Immutable(),
		field.String("human_brief_author_user_id").StorageKey("humanBriefAuthorUserId").Optional().Nillable().Immutable(),
		field.JSON("source_urls", []string{}).StorageKey("sourceUrls").Immutable(),
		field.Int("schema_version").StorageKey("schemaVersion").Default(1).Immutable(),
		field.JSON("requirements", []releasefacts.Audience{}).Immutable(),
		field.Enum("author_kind").StorageKey("authorKind").Values("session", "api_key").Immutable(),
		field.String("author_id").StorageKey("authorId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseQualification) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "release_id", "version").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
	}
}

type ReleaseQualificationDecision struct{ ent.Schema }

func (ReleaseQualificationDecision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_qualification_decision"}}
}

func (ReleaseQualificationDecision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("qualification_revision_id").StorageKey("qualificationRevisionId").Immutable(),
		field.Enum("decision").Values("QUALIFIED", "NO_COMMUNICATION", "DEFERRED", "WITHDRAWN").Immutable(),
		field.String("human_user_id").StorageKey("humanUserId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.String("reason").Immutable(),
		field.Time("revisit_at").StorageKey("revisitAt").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseQualificationDecision) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "release_id", "qualification_revision_id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
	}
}

// ReleaseQualificationAsset pins an uploaded source with database-enforced
// organization and release ownership, rather than hiding asset IDs in JSON.
type ReleaseQualificationAsset struct{ ent.Schema }

func (ReleaseQualificationAsset) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_qualification_asset"}}
}

func (ReleaseQualificationAsset) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("qualification_revision_id").StorageKey("qualificationRevisionId").Immutable(),
		field.String("asset_id").StorageKey("assetId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseQualificationAsset) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "release_id", "qualification_revision_id", "asset_id").Unique(),
		index.Fields("organization_id", "asset_id"),
	}
}

type ReadinessCommandReceipt struct{ ent.Schema }

func (ReadinessCommandReceipt) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_readiness_command_receipt"}}
}

func (ReadinessCommandReceipt) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.Enum("actor_kind").StorageKey("actorKind").Values("session", "api_key").Immutable(),
		field.String("actor_id").StorageKey("actorId").Immutable(),
		field.String("operation").Immutable(),
		field.String("command_key").StorageKey("commandKey").MaxLen(128).NotEmpty().Immutable(),
		field.String("request_sha256").StorageKey("requestSha256").MaxLen(64).Immutable(),
		field.JSON("response_ref", releasefacts.Result{}).StorageKey("responseRef").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReadinessCommandReceipt) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "actor_kind", "actor_id", "operation", "command_key").Unique()}
}

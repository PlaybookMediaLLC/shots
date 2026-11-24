package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
)

type ReleaseKit struct{ ent.Schema }

func (ReleaseKit) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_kit"}}
}
func (ReleaseKit) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("current_revision_id").StorageKey("currentRevisionId").Optional().Nillable(),
		field.String("approved_revision_id").StorageKey("approvedRevisionId").Optional().Nillable(),
		field.Int64("last_version").StorageKey("lastVersion").Default(0).NonNegative(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (ReleaseKit) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "release_id", "id").Unique(), index.Fields("organization_id", "release_id").Unique()}
}

type KitRevision struct{ ent.Schema }

func (KitRevision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_kit_revision"}}
}
func (KitRevision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("kit_id").StorageKey("kitId").Immutable(),
		field.Int64("version").Positive().Immutable(),
		field.String("qualification_revision_id").StorageKey("qualificationRevisionId").Immutable(),
		field.String("approver_user_id").StorageKey("approverUserId").Immutable(),
		field.String("requested_by_user_id").StorageKey("requestedByUserId").Immutable(),
		field.Enum("state").Values("DRAFT", "BUILDING", "REVIEWABLE", "APPROVED", "REJECTED", "SUPERSEDED", "WITHDRAWN", "FAILED").Default("DRAFT"),
		field.JSON("manifest", releasekits.Manifest{}),
		field.String("manifest_sha256").StorageKey("manifestSha256").Default(""),
		field.String("manifest_canonical").StorageKey("manifestCanonical").Default(""),
		field.String("preparation_job_id").StorageKey("preparationJobId").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Default(""),
		field.Time("prepared_at").StorageKey("preparedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitRevision) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "release_id", "id").Unique(), index.Fields("organization_id", "release_id", "kit_id", "id").Unique(), index.Fields("organization_id", "kit_id", "version").Unique()}
}

type KitArtifactRevision struct{ ent.Schema }

func (KitArtifactRevision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_artifact_revision"}}
}
func (KitArtifactRevision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.Enum("kind").Values("FACT_SHEET", "SALES_NOTES", "CS_NOTES", "ANNOUNCEMENT", "FAQ", "SCREENSHOT").Immutable(),
		field.String("audience_id").StorageKey("audienceId").Immutable(),
		field.Enum("classification").Values("INTERNAL_MATERIAL", "CUSTOMER_CLEARED").Immutable(),
		field.JSON("snapshot", releasekits.NativeSnapshot{}).Immutable(),
		field.String("snapshot_sha256").StorageKey("snapshotSha256").Immutable(),
		field.JSON("claim_links", []releasekits.ClaimLink{}).StorageKey("claimLinks").Immutable(),
		field.String("claim_map_sha256").StorageKey("claimMapSha256").Immutable(),
		field.String("output_key").StorageKey("outputKey").Optional().Nillable(),
		field.String("output_sha256").StorageKey("outputSha256").Optional().Nillable(),
		field.Int64("output_bytes").StorageKey("outputBytes").Default(0).NonNegative(),
		field.String("media_type").StorageKey("mediaType").Default(""),
		field.String("renderer_version").StorageKey("rendererVersion").Default(""),
		field.Time("prepared_at").StorageKey("preparedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitArtifactRevision) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "release_id", "id").Unique()}
}

type KitArtifactClaim struct{ ent.Schema }

func (KitArtifactClaim) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_artifact_claim"}}
}
func (KitArtifactClaim) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("artifact_revision_id").StorageKey("artifactRevisionId").Immutable(),
		field.String("node_id").StorageKey("nodeId").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.String("claim_version_id").StorageKey("claimVersionId").Immutable(),
		field.String("support_set_id").StorageKey("supportSetId").Optional().Nillable().Immutable(),
		field.String("verification_id").StorageKey("verificationId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitArtifactClaim) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "artifact_revision_id", "node_id", "claim_version_id").Unique(), index.Fields("organization_id", "claim_version_id", "artifact_revision_id")}
}

type KitMember struct{ ent.Schema }

func (KitMember) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_member"}}
}
func (KitMember) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("kit_revision_id").StorageKey("kitRevisionId").Immutable(),
		field.String("artifact_revision_id").StorageKey("artifactRevisionId").Immutable(),
		field.String("audience_id").StorageKey("audienceId").Immutable(),
		field.String("requirement_id").StorageKey("requirementId").Immutable(),
		field.Int("display_order").StorageKey("displayOrder").NonNegative().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitMember) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "kit_revision_id", "artifact_revision_id").Unique(), index.Fields("organization_id", "artifact_revision_id", "kit_revision_id")}
}

type KitSourcePin struct{ ent.Schema }

func (KitSourcePin) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_source_pin"}}
}
func (KitSourcePin) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("kit_revision_id").StorageKey("kitRevisionId").Immutable(),
		field.String("source_id").StorageKey("sourceId").Immutable(),
		field.Int64("acknowledged_sequence").StorageKey("acknowledgedSequence").NonNegative().Immutable(),
		field.JSON("evidence_version_ids", []string{}).StorageKey("evidenceVersionIds").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitSourcePin) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "kit_revision_id", "source_id").Unique(), index.Fields("organization_id", "source_id", "kit_revision_id")}
}

type KitReviewDecision struct{ ent.Schema }

func (KitReviewDecision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_review_decision"}}
}
func (KitReviewDecision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("kit_revision_id").StorageKey("kitRevisionId").Immutable(),
		field.Enum("review_type").StorageKey("reviewType").Values("CONTENT_COVERAGE", "FINAL_APPROVAL").Immutable(),
		field.Enum("decision").Values("APPROVE", "REJECT", "WITHDRAW").Immutable(),
		field.String("manifest_sha256").StorageKey("manifestSha256").Immutable(),
		field.String("dependency_token").StorageKey("dependencyToken").Immutable(),
		field.Int("policy_version").StorageKey("policyVersion").Positive().Immutable(),
		field.String("human_user_id").StorageKey("humanUserId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.String("reason").Immutable(),
		field.Bool("assertions_confirmed").StorageKey("assertionsConfirmed").Default(false).Immutable(),
		field.Bool("screenshots_confirmed").StorageKey("screenshotsConfirmed").Default(false).Immutable(),
		field.Bool("audience_confirmed").StorageKey("audienceConfirmed").Default(false).Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitReviewDecision) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "release_id", "id").Unique(), index.Fields("organization_id", "kit_revision_id", "review_type", "created_at", "id")}
}

type KitExport struct{ ent.Schema }

func (KitExport) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_kit_export"}}
}
func (KitExport) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("kit_revision_id").StorageKey("kitRevisionId").Immutable(),
		field.JSON("audience_ids", []string{}).StorageKey("audienceIds").Immutable(),
		field.String("audience_scope").StorageKey("audienceScope").Immutable(),
		field.Int("export_version").StorageKey("exportVersion").Default(1).Positive().Immutable(),
		field.String("requested_by_user_id").StorageKey("requestedByUserId").Immutable(),
		field.Enum("state").Values("BUILDING", "READY", "FAILED").Default("BUILDING"),
		field.String("object_key").StorageKey("objectKey").Optional().Nillable(),
		field.String("sha256").Optional().Nillable(),
		field.Int64("bytes").Default(0).NonNegative(),
		field.JSON("file_index", releasekits.PublicIndex{}).StorageKey("fileIndex"),
		field.String("failure_code").StorageKey("failureCode").Default(""),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}
func (KitExport) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "id").Unique(), index.Fields("organization_id", "release_id", "id").Unique(), index.Fields("organization_id", "kit_revision_id", "audience_scope", "export_version").Unique()}
}

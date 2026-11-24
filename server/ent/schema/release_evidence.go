package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"time"
)

type EvidenceSource struct{ ent.Schema }

func (EvidenceSource) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_evidence_source"}}
}

func (EvidenceSource) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Enum("kind").StorageKey("kind").Values("TEXT", "ATTESTATION", "ASSET", "RELEASE_SOURCE"),
		field.String("identity_sha256").StorageKey("identitySha256").Immutable(),
		field.Enum("access_class").StorageKey("accessClass").Values("PRIVATE_SOURCE", "INTERNAL_MATERIAL", "CUSTOMER_CLEARED").Default("PRIVATE_SOURCE"),
		field.Enum("availability").StorageKey("availability").Values("AVAILABLE", "UNAVAILABLE", "WITHDRAWN").Default("AVAILABLE"),
		field.Int64("change_sequence").StorageKey("changeSequence").Default(1).NonNegative(),
		field.String("current_version_id").StorageKey("currentVersionId").Optional().Nillable(),
		field.String("source_binding_id").StorageKey("sourceBindingId").Optional().Nillable(),
		field.Time("last_attempted_at").StorageKey("lastAttemptedAt").Optional().Nillable(),
		field.Time("last_success_at").StorageKey("lastSuccessAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (EvidenceSource) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "kind", "identity_sha256").Unique(),
		index.Fields("organization_id", "source_binding_id"),
	}
}

type EvidenceVersion struct{ ent.Schema }

func (EvidenceVersion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_evidence_version"}}
}

func (EvidenceVersion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_id").StorageKey("sourceId"),
		field.Int64("version").StorageKey("version").Default(1).NonNegative(),
		field.Enum("format").StorageKey("format").Values("TEXT", "IMAGE"),
		field.Enum("origin").StorageKey("origin").Values("HUMAN", "PROVIDER", "AI"),
		field.String("raw_sha256").StorageKey("rawSha256"),
		field.String("normalized_sha256").StorageKey("normalizedSha256"),
		field.String("normalization_version").StorageKey("normalizationVersion"),
		field.String("normalized_text").StorageKey("normalizedText").Optional().Nillable(),
		field.String("asset_id").StorageKey("assetId").Optional().Nillable(),
		field.String("source_url").StorageKey("sourceUrl").Optional().Nillable(),
		field.String("provider_revision").StorageKey("providerRevision").Default(""),
		field.Int64("byte_length").StorageKey("byteLength").Default(0).NonNegative(),
		field.Int("image_width").StorageKey("imageWidth").Default(0).NonNegative(),
		field.Int("image_height").StorageKey("imageHeight").Default(0).NonNegative(),
		field.String("redaction_asset_id").StorageKey("redactionAssetId").Optional().Nillable(),
		field.Time("observed_at").StorageKey("observedAt"),
		field.String("author_id").StorageKey("authorId"),
		field.String("confirmed_by_user_id").StorageKey("confirmedByUserId").Optional().Nillable(),
		field.Time("confirmed_at").StorageKey("confirmedAt").Optional().Nillable(),
		field.String("attestation_scope").StorageKey("attestationScope").Default(""),
		field.String("limitations").StorageKey("limitations").Default(""),
		field.Time("tombstoned_at").StorageKey("tombstonedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (EvidenceVersion) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "source_id", "id").Unique(),
		index.Fields("organization_id", "source_id", "version").Unique(),
		index.Fields("organization_id", "asset_id"),
	}
}

type ReleaseEvidence struct{ ent.Schema }

func (ReleaseEvidence) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_evidence"}}
}

func (ReleaseEvidence) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("evidence_version_id").StorageKey("evidenceVersionId").Immutable(),
		field.String("purpose").StorageKey("purpose").Immutable(),
		field.String("attached_by_user_id").StorageKey("attachedByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseEvidence) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "evidence_version_id").Unique(),
		index.Fields("organization_id", "evidence_version_id"),
	}
}

type EvidenceClearance struct{ ent.Schema }

func (EvidenceClearance) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_evidence_clearance"}}
}

func (EvidenceClearance) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("evidence_version_id").StorageKey("evidenceVersionId").Immutable(),
		field.JSON("audience_ids", []string{}).StorageKey("audienceIds").Immutable(),
		field.String("human_user_id").StorageKey("humanUserId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.String("reason").StorageKey("reason").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (EvidenceClearance) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "evidence_version_id", "created_at"),
	}
}

type ReleaseClaim struct{ ent.Schema }

func (ReleaseClaim) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_claim"}}
}

func (ReleaseClaim) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId"),
		field.String("current_version_id").StorageKey("currentVersionId").Optional().Nillable(),
		field.String("current_support_set_id").StorageKey("currentSupportSetId").Optional().Nillable(),
		field.String("current_decision_id").StorageKey("currentDecisionId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseClaim) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "created_at", "id"),
	}
}

type ReleaseClaimVersion struct{ ent.Schema }

func (ReleaseClaimVersion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_release_claim_version"}}
}

func (ReleaseClaimVersion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.Int64("version").StorageKey("version").Default(1).NonNegative().Immutable(),
		field.String("spec_id").StorageKey("specId").Optional().Nillable().Immutable(),
		field.String("text").StorageKey("text").Immutable(),
		field.JSON("qualifiers", releasefacts.ClaimQualifiers{}).StorageKey("qualifiers").Immutable(),
		field.String("content_sha256").StorageKey("contentSha256").Immutable(),
		field.Enum("origin").StorageKey("origin").Values("HUMAN", "PROVIDER", "AI").Immutable(),
		field.String("author_id").StorageKey("authorId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ReleaseClaimVersion) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "claim_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "claim_id", "version").Unique(),
	}
}

type ClaimSupportSet struct{ ent.Schema }

func (ClaimSupportSet) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_claim_support_set"}}
}

func (ClaimSupportSet) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.String("claim_version_id").StorageKey("claimVersionId").Immutable(),
		field.Int64("version").StorageKey("version").Default(1).NonNegative().Immutable(),
		field.String("support_sha256").StorageKey("supportSha256").Immutable(),
		field.JSON("source_pins", []releasefacts.SupportReference{}).StorageKey("sourcePins").Immutable(),
		field.String("author_id").StorageKey("authorId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ClaimSupportSet) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "claim_id", "claim_version_id", "id").Unique(),
		index.Fields("organization_id", "claim_version_id", "version").Unique(),
	}
}

type ClaimSupport struct{ ent.Schema }

func (ClaimSupport) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_claim_support"}}
}

func (ClaimSupport) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.String("claim_version_id").StorageKey("claimVersionId").Immutable(),
		field.String("support_set_id").StorageKey("supportSetId").Immutable(),
		field.String("evidence_version_id").StorageKey("evidenceVersionId").Immutable(),
		field.Enum("relation").StorageKey("relation").Values("SUPPORTS", "CONTRADICTS", "CONTEXT").Immutable(),
		field.JSON("selector", releasefacts.EvidenceSelector{}).StorageKey("selector").Immutable(),
		field.String("selector_sha256").StorageKey("selectorSha256").Immutable(),
		field.String("exclusion_reason").StorageKey("exclusionReason").Default("").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ClaimSupport) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "support_set_id", "evidence_version_id", "relation", "selector_sha256").Unique(),
		index.Fields("organization_id", "evidence_version_id", "claim_version_id"),
	}
}

type ClaimVerification struct{ ent.Schema }

func (ClaimVerification) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_claim_verification"}}
}

func (ClaimVerification) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.String("claim_version_id").StorageKey("claimVersionId").Immutable(),
		field.String("support_set_id").StorageKey("supportSetId").Immutable(),
		field.String("support_sha256").StorageKey("supportSha256").Immutable(),
		field.String("claim_sha256").StorageKey("claimSha256").Immutable(),
		field.Enum("decision").StorageKey("decision").Values("SUPPORTED", "CONTRADICTED", "UNRESOLVED", "WITHDRAWN").Immutable(),
		field.String("human_user_id").StorageKey("humanUserId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.String("reason").StorageKey("reason").Immutable(),
		field.String("supersedes_id").StorageKey("supersedesId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ClaimVerification) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "claim_id", "claim_version_id", "id").Unique(),
		index.Fields("organization_id", "claim_version_id", "created_at", "id"),
	}
}

type ClaimPathBinding struct{ ent.Schema }

func (ClaimPathBinding) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_claim_path_binding"}}
}

func (ClaimPathBinding) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Immutable(),
		field.String("spec_id").StorageKey("specId").Immutable(),
		field.String("legacy_path").StorageKey("legacyPath").Immutable(),
		field.String("claim_id").StorageKey("claimId").Immutable(),
		field.String("claim_version_id").StorageKey("claimVersionId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (ClaimPathBinding) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "release_id", "id").Unique(),
		index.Fields("organization_id", "spec_id", "legacy_path").Unique(),
	}
}

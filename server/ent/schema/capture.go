package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PlatformAppConnection is a customer app that authenticated captures sign in
// to. The state ciphertext never leaves the backend: no DTO, prompt, workflow
// history, outbox payload, or log carries it.
type PlatformAppConnection struct{ ent.Schema }

func (PlatformAppConnection) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_app_connection"}}
}

func (PlatformAppConnection) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Optional().Nillable(),
		field.String("name").StorageKey("name"),
		field.String("environment").StorageKey("environment"),
		field.String("origin").StorageKey("origin"),
		// Hosts bound every capture; LoginHosts are added only while a person signs in.
		field.JSON("hosts", []string{}).StorageKey("hosts"),
		field.JSON("login_hosts", []string{}).StorageKey("loginHosts"),
		field.String("protected_path").StorageKey("protectedPath"),
		field.String("identity_selector").StorageKey("identitySelector"),
		field.String("expected_account").StorageKey("expectedAccount"),
		field.Enum("status").StorageKey("status").Values("CONNECTING", "READY", "NEEDS_AUTH", "REVOKED").Default("CONNECTING"),
		field.String("state_ciphertext").StorageKey("stateCiphertext").Optional().Nillable().Sensitive(),
		// Generation rises on every sign-in and on revocation; it is sealed into
		// the state and pinned on jobs, so stale work cannot use newer access.
		field.Int("generation").StorageKey("generation").Default(1),
		field.Int("state_revision").StorageKey("stateRevision").Default(0),
		field.Time("validated_at").StorageKey("validatedAt").Optional().Nillable(),
		field.Time("state_expires_at").StorageKey("stateExpiresAt").Optional().Nillable(),
		field.String("connect_intent_id").StorageKey("connectIntentId").Optional().Nillable().Sensitive(),
		field.String("connect_user_id").StorageKey("connectUserId").Optional().Nillable(),
		field.String("connect_session_id").StorageKey("connectSessionId").Optional().Nillable(),
		field.Time("connect_expires_at").StorageKey("connectExpiresAt").Optional().Nillable(),
		field.String("connect_phase").StorageKey("connectPhase").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		// One job at a time holds the lease; its token fences a late result.
		field.String("lease_job_id").StorageKey("leaseJobId").Optional().Nillable(),
		field.Int64("lease_token").StorageKey("leaseToken").Default(0),
		field.Time("lease_expires_at").StorageKey("leaseExpiresAt").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.Time("revoked_at").StorageKey("revokedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (PlatformAppConnection) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "name").Unique()}
}

// CaptureRecipe is an immutable version of one screen's capture.
type CaptureRecipe struct{ ent.Schema }

func (CaptureRecipe) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_recipe"}}
}

func (CaptureRecipe) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Optional().Nillable().Immutable(),
		field.String("name").StorageKey("name").Immutable(),
		field.Int("version").StorageKey("version").Immutable(),
		field.JSON("definition", map[string]any{}).StorageKey("definition").Immutable(),
		field.Enum("status").StorageKey("status").Values("DRAFT", "ACTIVE", "ARCHIVED").Default("DRAFT"),
		field.String("surface_id").StorageKey("surfaceId").Optional().Nillable().Immutable(),
		field.String("app_connection_id").StorageKey("appConnectionId").Optional().Nillable().Immutable(),
		field.String("definition_hash").StorageKey("definitionHash").Optional().Nillable().Immutable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		// TestedAt is set by a successful test capture of this exact version.
		field.Time("tested_at").StorageKey("testedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CaptureRecipe) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "name", "version").Unique()}
}

// CaptureJob is one business capture: a recipe version for a deployment, a
// test, or a person's request. Workflow retries never create another.
type CaptureJob struct{ ent.Schema }

func (CaptureJob) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_job"}}
}

func (CaptureJob) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Optional().Nillable(),
		field.String("recipe_id").StorageKey("recipeId").Immutable(),
		field.Int("recipe_version").StorageKey("recipeVersion").Immutable(),
		// Status is the shared execution enum; Phase is this job's own meaning.
		field.Enum("status").StorageKey("status").Values("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED").Default("QUEUED"),
		field.Enum("phase").StorageKey("phase").Values("QUEUED", "WAITING_DEPLOYMENT", "RUNNING", "NEEDS_AUTH", "SUCCEEDED", "FAILED", "CANCELLED").Default("QUEUED"),
		field.Enum("kind").StorageKey("kind").Values("test", "manual", "agent", "deployment").Default("manual").Immutable(),
		// TriggerRunID is the agent run that asked for this capture.
		field.String("trigger_run_id").StorageKey("triggerRunId").Optional().Nillable().Immutable(),
		field.String("idempotency_key").StorageKey("idempotencyKey").Immutable(),
		field.Int("attempts").StorageKey("attempts").Default(0),
		// Reserved before a model attempt; infrastructure and deployment waits do not spend it.
		field.Int("navigation_attempts").StorageKey("navigationAttempts").Default(0),
		field.String("surface_id").StorageKey("surfaceId").Optional().Nillable().Immutable(),
		field.String("app_connection_id").StorageKey("appConnectionId").Optional().Nillable().Immutable(),
		field.Int("connection_generation").StorageKey("connectionGeneration").Default(0),
		field.String("deployment_event_id").StorageKey("deploymentEventId").Optional().Nillable().Immutable(),
		field.String("expected_revision").StorageKey("expectedRevision").Optional().Nillable().Immutable(),
		field.String("recipe_hash").StorageKey("recipeHash").Optional().Nillable().Immutable(),
		field.Int64("fencing_token").StorageKey("fencingToken").Default(0),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.Time("deadline_at").StorageKey("deadlineAt").Optional().Nillable(),
		field.String("requested_by_user_id").StorageKey("requestedByUserId").Optional().Nillable().Immutable(),
		field.String("surface_capture_id").StorageKey("surfaceCaptureId").Optional().Nillable(),
		field.String("asset_id").StorageKey("assetId").Optional().Nillable(),
		field.Int("resume_count").StorageKey("resumeCount").Default(0),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CaptureJob) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "idempotency_key").Unique(), index.Fields("organization_id", "created_at")}
}

// CaptureAttempt is one try at a job, kept in the legacy capture table. The
// browser session reference lets cleanup reclaim it after a worker crash; a
// provider URL carrying credentials is never stored here.
type CaptureAttempt struct{ ent.Schema }

func (CaptureAttempt) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture"}}
}

func (CaptureAttempt) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("release_id").StorageKey("releaseId").Optional().Nillable(),
		field.String("capture_job_id").StorageKey("captureJobId").Immutable(),
		field.String("recipe_id").StorageKey("recipeId").Immutable(),
		field.Int("recipe_version").StorageKey("recipeVersion").Immutable(),
		field.String("source_url").StorageKey("sourceUrl"),
		field.String("provider").StorageKey("provider"),
		field.Enum("status").StorageKey("status").Values("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED").Default("QUEUED"),
		field.Time("started_at").StorageKey("startedAt").Optional().Nillable(),
		field.Time("completed_at").StorageKey("completedAt").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.Int("attempt_number").StorageKey("attemptNumber").Immutable(),
		field.String("browser_session_id").StorageKey("browserSessionId").Optional().Nillable(),
		field.Time("browser_closed_at").StorageKey("browserClosedAt").Optional().Nillable(),
		field.String("observed_revision").StorageKey("observedRevision").Optional().Nillable(),
		field.Int64("fencing_token").StorageKey("fencingToken").Default(0),
		field.Int("refused_requests").StorageKey("refusedRequests").Default(0),
		// AssetID is a stored image not yet committed, so a retry reuses it.
		field.String("asset_id").StorageKey("assetId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CaptureAttempt) Indexes() []ent.Index {
	return []ent.Index{index.Fields("capture_job_id", "attempt_number").Unique()}
}

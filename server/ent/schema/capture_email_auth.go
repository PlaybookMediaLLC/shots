package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// CaptureEmailAuthConfig lets Shots sign in to one connection by itself, with
// a first-factor email link or code sent to a Shots-owned address (RFC 007A).
// It holds no secret: the address is a routing name, not a credential.
type CaptureEmailAuthConfig struct{ ent.Schema }

func (CaptureEmailAuthConfig) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_email_auth_config"}}
}

func (CaptureEmailAuthConfig) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("connection_id").StorageKey("connectionId").Immutable(),
		field.String("environment").StorageKey("environment").Immutable(),
		field.String("recipient_local_part").StorageKey("recipientLocalPart").Immutable(),
		field.String("recipient_domain").StorageKey("recipientDomain").Immutable(),
		field.Enum("method").StorageKey("method").Values("MAGIC_LINK", "EMAIL_CODE"),
		field.String("recipe_version_id").StorageKey("recipeVersionId").Optional().Nillable(),
		field.JSON("expected_senders", []string{}).StorageKey("expectedSenders"),
		// AutoReconnect is the owner's separate opt-in after a passing test.
		field.Bool("auto_reconnect").StorageKey("autoReconnect").Default(false),
		field.Enum("status").StorageKey("status").Values("DRAFT", "VERIFIED", "PAUSED", "REVOKED").Default("DRAFT"),
		// Revision changes with every policy or recipe change; a test proves one revision.
		field.Int("revision").StorageKey("revision").Default(1),
		field.Int("tested_revision").StorageKey("testedRevision").Optional().Nillable(),
		field.Time("last_tested_at").StorageKey("lastTestedAt").Optional().Nillable(),
		field.Time("last_success_at").StorageKey("lastSuccessAt").Optional().Nillable(),
		field.String("last_failure_code").StorageKey("lastFailureCode").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.String("approved_by_user_id").StorageKey("approvedByUserId").Optional().Nillable(),
		field.Time("approved_at").StorageKey("approvedAt").Optional().Nillable(),
		field.Time("revoked_at").StorageKey("revokedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CaptureEmailAuthConfig) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("connection_id").Unique(),
		index.Fields("recipient_local_part", "recipient_domain").Unique(),
		index.Fields("organization_id", "connection_id"),
	}
}

// CaptureAuthRecipeVersion is one immutable, typed login recipe. It is never a
// capture recipe: a login submits forms, a capture must not.
type CaptureAuthRecipeVersion struct{ ent.Schema }

func (CaptureAuthRecipeVersion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_auth_recipe_version"}}
}

func (CaptureAuthRecipeVersion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("connection_id").StorageKey("connectionId").Immutable(),
		field.String("config_id").StorageKey("configId").Immutable(),
		field.Int("version").StorageKey("version").Immutable(),
		field.JSON("definition", map[string]any{}).StorageKey("definition").Immutable(),
		field.String("definition_hash").StorageKey("definitionHash").Immutable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (CaptureAuthRecipeVersion) Indexes() []ent.Index {
	return []ent.Index{index.Fields("config_id", "version").Unique()}
}

// CaptureAuthAttemptActiveStates are the states that hold the connection's one
// automatic sign-in slot. The partial unique index below repeats this list.
var CaptureAuthAttemptActiveStates = []string{"ADMITTED", "BROWSER_STARTING", "CHALLENGE_REQUESTED", "WAITING_FOR_EMAIL", "EMAIL_MATCHED", "APPLYING_CHALLENGE", "VERIFYING", "COMMITTING"}

// CaptureAuthAttempt is one automatic email sign-in. It pins the authority it
// started under; no link, code, cookie, or email body is ever stored on it.
type CaptureAuthAttempt struct{ ent.Schema }

func (CaptureAuthAttempt) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_auth_attempt"}}
}

func (CaptureAuthAttempt) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("connection_id").StorageKey("connectionId").Immutable(),
		field.String("config_id").StorageKey("configId").Immutable(),
		field.Int("config_revision").StorageKey("configRevision").Immutable(),
		field.String("recipe_version_id").StorageKey("recipeVersionId").Immutable(),
		field.String("recipe_hash").StorageKey("recipeHash").Immutable(),
		field.Int("connection_generation").StorageKey("connectionGeneration").Immutable(),
		field.Enum("mode").StorageKey("mode").Values("TEST", "AUTO_RECOVER").Immutable(),
		field.Enum("state").StorageKey("state").Values(append(append([]string{}, CaptureAuthAttemptActiveStates...), "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED", "HUMAN_REQUIRED")...).Default("ADMITTED"),
		// BrowserSessionID is an operational reference, never shown to a client.
		field.String("browser_session_id").StorageKey("browserSessionId").Optional().Nillable(),
		field.Time("browser_closed_at").StorageKey("browserClosedAt").Optional().Nillable(),
		field.Time("email_requested_at").StorageKey("emailRequestedAt").Optional().Nillable(),
		field.Time("email_received_at").StorageKey("emailReceivedAt").Optional().Nillable(),
		field.String("receipt_id").StorageKey("receiptId").Optional().Nillable(),
		field.Time("deadline_at").StorageKey("deadlineAt"),
		field.Time("completed_at").StorageKey("completedAt").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		// FenceToken grows on every claim, so a stale worker cannot write.
		field.Int64("fence_token").StorageKey("fenceToken").Default(0),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		field.String("trigger_capture_job_id").StorageKey("triggerCaptureJobId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CaptureAuthAttempt) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("connection_id").Unique().Annotations(entsql.IndexWhere(`"state" IN ('ADMITTED','BROWSER_STARTING','CHALLENGE_REQUESTED','WAITING_FOR_EMAIL','EMAIL_MATCHED','APPLYING_CHALLENGE','VERIFYING','COMMITTING')`)),
		index.Fields("organization_id", "created_at"),
		index.Fields("connection_id", "created_at"),
	}
}

// CaptureInboundReceipt records one verified inbound email notification. It
// keeps provider IDs and a recipient hash only: no body, subject, or headers.
type CaptureInboundReceipt struct{ ent.Schema }

func (CaptureInboundReceipt) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "capture_inbound_receipt"}}
}

func (CaptureInboundReceipt) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("provider").StorageKey("provider").Immutable(),
		field.String("provider_event_id").StorageKey("providerEventId").Immutable(),
		field.String("provider_email_id").StorageKey("providerEmailId").Immutable(),
		field.String("recipient_hash").StorageKey("recipientHash").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Optional().Nillable(),
		field.String("config_id").StorageKey("configId").Optional().Nillable(),
		field.String("attempt_id").StorageKey("attemptId").Optional().Nillable(),
		field.Enum("state").StorageKey("state").Values("RECEIVED", "ASSIGNED", "CONSUMED", "IGNORED", "FAILED").Default("RECEIVED"),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.Time("received_at").StorageKey("receivedAt"),
		field.Time("processed_at").StorageKey("processedAt").Optional().Nillable(),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (CaptureInboundReceipt) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("provider", "provider_event_id").Unique(),
		index.Fields("provider", "provider_email_id").Unique(),
		index.Fields("attempt_id"),
		index.Fields("expires_at"),
	}
}

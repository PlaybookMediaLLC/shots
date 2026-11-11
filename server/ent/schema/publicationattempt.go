package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/edge"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PublicationAttempt records every irreversible provider mutation attempt.
type PublicationAttempt struct{ ent.Schema }

func (PublicationAttempt) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "publication_attempt"}}
}

func (PublicationAttempt) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("scheduled_post_id").StorageKey("scheduledPostId").Immutable(),
		field.Int("attempt_number").StorageKey("attemptNumber").Positive().Immutable(),
		field.Time("started_at").StorageKey("startedAt").Default(time.Now).Immutable(),
		field.Time("completed_at").StorageKey("completedAt").Optional().Nillable(),
		field.Enum("outcome").StorageKey("outcome").Values("SUCCEEDED", "FAILED").Optional().Nillable(),
		field.String("provider_post_id").StorageKey("providerPostId").Optional().Nillable(),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		// The provider's message, redacted (publishing.RedactProviderMessage); never shown raw to members.
		field.String("provider_message").StorageKey("providerMessage").Optional().Nillable(),
		field.String("remote_url").StorageKey("remoteUrl").Optional().Nillable(),
	}
}

func (PublicationAttempt) Edges() []ent.Edge {
	return []ent.Edge{
		edge.From("scheduled_post", ScheduledPost.Type).
			Ref("attempts").
			Field("scheduled_post_id").
			Unique().
			Required().
			Immutable(),
	}
}

func (PublicationAttempt) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("scheduled_post_id", "attempt_number").Unique(),
		index.Fields("organization_id", "started_at"),
	}
}

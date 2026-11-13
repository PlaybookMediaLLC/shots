package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PostAutomationRun is the receipt of one follow-up of a live post (RFC 025):
// a first comment, a repost and its removal, a plug reply. One row per post
// and key; a retried step reads it first, so it never acts twice, and
// cancelling marks the pending ones.
type PostAutomationRun struct{ ent.Schema }

func (PostAutomationRun) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "post_automation_run"}}
}

func (PostAutomationRun) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("scheduled_post_id").StorageKey("scheduledPostId").Immutable(),
		field.String("key").StorageKey("key").Immutable(),
		field.Enum("kind").StorageKey("kind").Values("first_comment", "retweet", "unretweet", "plug", "repost_at_likes", "quote", "thumbnail").Immutable(),
		field.Enum("status").StorageKey("status").Values("pending", "done", "failed", "skipped", "cancelled", "expired").Default("pending"),
		field.Time("due_at").StorageKey("dueAt"),
		field.String("remote_id").StorageKey("remoteId").Optional().Nillable(),
		field.Int("attempts").StorageKey("attempts").Default(0),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.String("provider_message").StorageKey("providerMessage").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (PostAutomationRun) Indexes() []ent.Index {
	return []ent.Index{index.Fields("scheduled_post_id", "key").Unique()}
}

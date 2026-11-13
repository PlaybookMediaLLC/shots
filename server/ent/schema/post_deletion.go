package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PostDeletion is the receipt of one part of deleting a published post from
// its platform: the root, a thread continuation, a follow-up reply, or a
// repost to undo. One row per post and part; a retried delete reads it first,
// so a part that is done is never called again.
type PostDeletion struct{ ent.Schema }

func (PostDeletion) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "post_deletion"}}
}

func (PostDeletion) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("scheduled_post_id").StorageKey("scheduledPostId").Immutable(),
		// root, thread:<n>, first_comment, plug, quote or repost:<n>.
		field.String("key").StorageKey("key").Immutable(),
		// post deletes a remote record; repost undoes a repost of the root.
		field.Enum("kind").StorageKey("kind").Values("post", "repost").Immutable(),
		field.String("remote_id").StorageKey("remoteId").Immutable(),
		field.Enum("status").StorageKey("status").Values("pending", "done", "failed", "unsupported").Default("pending"),
		field.Int("attempts").StorageKey("attempts").Default(0),
		// A short code, never the provider's message: the HTTP status or a reason.
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		// Who asked: a member, or "api-key:<id>" for a key.
		field.String("requested_by").StorageKey("requestedBy").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (PostDeletion) Indexes() []ent.Index {
	return []ent.Index{index.Fields("scheduled_post_id", "key").Unique()}
}

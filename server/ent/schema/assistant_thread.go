package schema

import (
	"encoding/json"
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// AssistantThread is one person's saved chat with the Shots assistant in one
// workspace. It is private to that person, unlike a Conversation, which the
// workspace shares. The entries are what the thread shows; they hold no state.
type AssistantThread struct{ ent.Schema }

func (AssistantThread) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "assistant_thread"}}
}

func (AssistantThread) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("title").StorageKey("title"),
		field.JSON("entries", json.RawMessage{}).StorageKey("entries"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (AssistantThread) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id", "updated_at")}
}

package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// PlatformSignupSource is where a person heard about Shots, as they answered
// it when they created their first workspace. One row per person: the first
// answer is kept. The workspace ID outlives a workspace purge, as a creation
// receipt's does; deleting the account deletes the answer.
type PlatformSignupSource struct{ ent.Schema }

func (PlatformSignupSource) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_signup_source"}}
}

func (PlatformSignupSource) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Enum("source").StorageKey("source").Values(
			"search", "ai_assistant", "x", "linkedin", "youtube", "tiktok_instagram", "reddit",
			"product_hunt_hacker_news", "friend_colleague", "newsletter_blog_podcast",
			"event_community", "other",
		).Immutable(),
		// Up to 200 characters, checked in product and by the column; MaxLen would count bytes.
		field.String("detail").StorageKey("detail").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (PlatformSignupSource) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id").Unique()}
}

package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// VoiceCommand is the one scheduling proposal parsed from a voice note (plan
// 5.4). The spoken words propose; only a confirmed proposal reaches the
// scheduler. LocalTime is a wall-clock time in TimeZone, never an instant.
type VoiceCommand struct{ ent.Schema }

func (VoiceCommand) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_command"}}
}

func (VoiceCommand) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("owner_user_id").StorageKey("ownerUserId").Immutable(),
		field.String("note_id").StorageKey("noteId").Unique().Immutable(),
		field.String("transcript_revision_id").StorageKey("transcriptRevisionId"),
		field.Enum("status").Values("waiting", "proposed", "confirmed", "expired", "withdrawn", "failed").Default("waiting"),
		field.Enum("action").Values("schedule_post", "create_draft", "none").Default("none"),
		field.String("platform").Optional().Nillable(),
		field.Text("text").Optional().Nillable(),
		field.String("local_time").StorageKey("localTime").Optional().Nillable(),
		field.String("time_zone").StorageKey("timeZone"),
		field.Time("scheduled_for").StorageKey("scheduledFor").Optional().Nillable(),
		field.String("channel_connection_id").StorageKey("channelConnectionId").Optional().Nillable(),
		field.JSON("guessed", []string{}).Default([]string{}),
		field.JSON("flags", []string{}).Default([]string{}),
		field.String("notice").Optional().Nillable(),
		field.Int("attempts").Default(0).NonNegative(),
		field.Time("next_attempt_at").StorageKey("nextAttemptAt").Optional().Nillable(),
		field.Time("expires_at").StorageKey("expiresAt").Optional().Nillable(),
		field.String("content_draft_id").StorageKey("contentDraftId").Optional().Nillable(),
		field.String("scheduled_post_id").StorageKey("scheduledPostId").Optional().Nillable(),
		field.String("failure_reason").StorageKey("failureReason").Optional().Nillable(),
		// Outcome is what a confirm did, returned again to a resent confirm (K11).
		field.Enum("outcome").Values("scheduled", "pending_approval", "draft").Optional().Nillable(),
		// ParsedAt is the last model call, which the per-member parse limit counts.
		field.Time("parsed_at").StorageKey("parsedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

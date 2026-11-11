package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// VoiceNote is a member's private recording (docs/plans/voice-capture-and-evidence-plan.md
// 5.2). Only its owner reads it; the workspace sees it only through a draft made
// from one of its transcript revisions. A deleted note keeps its row as a
// tombstone, so a replayed create from an offline phone never recreates it.
type VoiceNote struct{ ent.Schema }

func (VoiceNote) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_note"}}
}

func (VoiceNote) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("owner_user_id").StorageKey("ownerUserId").Immutable(),
		field.String("client_note_id").StorageKey("clientNoteId").Immutable(),
		field.String("title").Default(""),
		field.String("project_id").StorageKey("projectId").Optional().Nillable(),
		// RecordedAt is the phone's claim; ReceivedAt is the server's clock (S14).
		field.Time("recorded_at").StorageKey("recordedAt").Immutable(),
		field.String("recorded_time_zone").StorageKey("recordedTimeZone").Immutable(),
		field.Time("received_at").StorageKey("receivedAt").Default(time.Now).Immutable(),
		field.String("locale").Optional().Nillable(),
		field.Int("duration_ms").StorageKey("durationMs").Optional().Nillable(),
		field.Bool("audio_upload_consent").StorageKey("audioUploadConsent").Default(false),
		// Revision bumps on every change the phone must pull.
		field.Int("revision").Default(1),
		field.String("current_transcript_revision_id").StorageKey("currentTranscriptRevisionId").Optional().Nillable(),
		field.Time("deleted_at").StorageKey("deletedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (VoiceNote) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "owner_user_id", "client_note_id").Unique(),
		index.Fields("organization_id", "owner_user_id", "received_at"),
	}
}

// VoiceTranscriptRevision is insert-only. Redaction clears text and segments and
// sets RedactedAt through an audited purge; nothing else changes a row.
type VoiceTranscriptRevision struct{ ent.Schema }

// VoiceSegment is a span of transcript on the note timeline. Approximate marks a
// recognizer restart boundary where words may be missing.
type VoiceSegment struct {
	StartMs     int    `json:"startMs"`
	EndMs       int    `json:"endMs"`
	Text        string `json:"text"`
	Approximate bool   `json:"approximate,omitempty"`
}

func (VoiceTranscriptRevision) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_transcript_revision"}}
}

func (VoiceTranscriptRevision) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("note_id").StorageKey("noteId").Immutable(),
		field.String("client_revision_id").StorageKey("clientRevisionId").Immutable(),
		field.String("parent_id").StorageKey("parentId").Optional().Nillable().Immutable(),
		field.Enum("origin").Values("on_device", "remote", "user_edit").Immutable(),
		field.String("locale").Optional().Nillable().Immutable(),
		field.String("engine").Optional().Nillable().Immutable(),
		field.Text("text"),
		field.JSON("segments", []VoiceSegment{}).Default([]VoiceSegment{}),
		field.Time("redacted_at").StorageKey("redactedAt").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (VoiceTranscriptRevision) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("note_id", "client_revision_id").Unique(),
		index.Fields("note_id", "created_at"),
	}
}

// VoiceAudioRun is one uninterrupted recording file, uploaded whole. Its object
// lives under a voice key, not as an asset row: assets are visible to the whole
// workspace and voice audio is private to its owner.
type VoiceAudioRun struct{ ent.Schema }

func (VoiceAudioRun) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_audio_run"}}
}

func (VoiceAudioRun) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("note_id").StorageKey("noteId").Immutable(),
		field.Int("run_index").StorageKey("runIndex").NonNegative().Immutable(),
		field.Int("start_offset_ms").StorageKey("startOffsetMs").NonNegative(),
		field.Int("client_duration_ms").StorageKey("clientDurationMs").Optional().Nillable(),
		// DurationMs is decoded by the server and used for display and metering (S19).
		field.Int("duration_ms").StorageKey("durationMs").Optional().Nillable(),
		field.Int("sample_rate_hz").StorageKey("sampleRateHz").Optional().Nillable(),
		field.String("content_type").StorageKey("contentType"),
		field.Int64("bytes").Positive(),
		field.String("sha256"),
		field.String("object_key").StorageKey("objectKey").Unique(),
		field.Enum("status").Values("pending", "available", "failed", "deleted").Default("pending"),
		field.String("failure_reason").StorageKey("failureReason").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (VoiceAudioRun) Indexes() []ent.Index {
	return []ent.Index{index.Fields("note_id", "run_index").Unique()}
}

// VoiceSettings is a workspace's voice switches, all off by default (6.9).
type VoiceSettings struct{ ent.Schema }

func (VoiceSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_settings"}}
}

func (VoiceSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.Bool("voice_notes").StorageKey("voiceNotes").Default(false),
		field.Bool("audio_upload").StorageKey("audioUpload").Default(false),
		field.Bool("draft_generation").StorageKey("draftGeneration").Default(false),
		field.Bool("voice_commands").StorageKey("voiceCommands").Default(false),
		field.String("updated_by_user_id").StorageKey("updatedByUserId").Optional().Nillable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

// VoiceMemberSettings is one member's voice choices in one workspace: the
// disclosed consent to send transcript text to a model provider (5.3) and
// whether their transcripts are parsed for commands (5.4).
type VoiceMemberSettings struct{ ent.Schema }

func (VoiceMemberSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "voice_member_settings"}}
}

func (VoiceMemberSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.Time("remote_text_consent_at").StorageKey("remoteTextConsentAt").Optional().Nillable(),
		field.Bool("voice_commands").StorageKey("voiceCommands").Default(false),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (VoiceMemberSettings) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id").Unique()}
}

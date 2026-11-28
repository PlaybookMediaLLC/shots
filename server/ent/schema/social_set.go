package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// SocialSet is a publishing identity (RFC 024): the accounts one person or
// brand posts from, with that identity's schedule, new-draft defaults, public
// profile and Writing Assistant. Names repeat; the ID is the identity.
type SocialSet struct{ ent.Schema }

// EngagementRule is one X follow-up a new draft starts with: on, after how
// many likes, and (for an auto-reply) its text.
type EngagementRule struct {
	Enabled bool   `json:"enabled"`
	AtLikes int    `json:"atLikes"`
	Text    string `json:"text,omitempty"`
}

// Engagement is the X follow-ups a set's new drafts start with.
type Engagement struct {
	AutoRepost EngagementRule `json:"autoRepost"`
	AutoPlug   EngagementRule `json:"autoPlug"`
}

// StyleGuide is how a set writes; it refines the workspace brand voice.
type StyleGuide struct {
	Tone              string            `json:"tone"`
	Audience          string            `json:"audience"`
	Terminology       []string          `json:"terminology"`
	ProhibitedPhrases []string          `json:"prohibitedPhrases"`
	Formatting        string            `json:"formatting"`
	Openings          []string          `json:"openings"`
	Endings           []string          `json:"endings"`
	PlatformGuidance  map[string]string `json:"platformGuidance"`
}

// WritingAssistant is a set's assistant: created or not, turned off or not,
// and its style guide.
type WritingAssistant struct {
	// Status is empty until created, then configured or disabled.
	Status       string     `json:"status,omitempty"`
	ConfiguredAt *time.Time `json:"configuredAt,omitempty"`
	StyleGuide   StyleGuide `json:"styleGuide"`
}

func (SocialSet) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "social_set"}}
}

func (SocialSet) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("name").StorageKey("name"),
		field.String("color").StorageKey("color").Default("#3b82f6"),
		// WORKSPACE sets are shared with the workspace; a PRIVATE set is its owner's alone.
		field.Enum("visibility").StorageKey("visibility").Values("WORKSPACE", "PRIVATE").Default("WORKSPACE"),
		field.String("owner_user_id").StorageKey("ownerUserId").Optional().Nillable(),
		field.String("time_zone").StorageKey("timeZone").Default("UTC"),
		field.JSON("posting_slots", []QueueSlot{}).StorageKey("postingSlots").Default([]QueueSlot{}),
		field.Bool("natural_posting_times").StorageKey("naturalPostingTimes").Default(false),
		field.Int("natural_posting_window_minutes").StorageKey("naturalPostingWindowMinutes").Default(10).Min(1).Max(15),
		// Platforms a new draft starts with, in order.
		field.JSON("default_platforms", []string{}).StorageKey("defaultPlatforms").Default([]string{}),
		field.String("primary_platform").StorageKey("primaryPlatform").Optional().Nillable(),
		field.JSON("engagement_defaults", Engagement{}).StorageKey("engagementDefaults").Default(Engagement{}),
		field.Bool("public_profile").StorageKey("publicProfile").Default(false),
		field.String("public_slug").StorageKey("publicSlug").Immutable(),
		field.JSON("writing_assistant", WritingAssistant{}).StorageKey("writingAssistant").Default(WritingAssistant{}),
		field.Int("version").StorageKey("version").Default(1),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
		field.Time("deleted_at").StorageKey("deletedAt").Optional().Nillable(),
	}
}

func (SocialSet) Indexes() []ent.Index {
	return []ent.Index{index.Fields("public_slug").Unique(), index.Fields("organization_id", "created_at")}
}

// SocialSetWritingSample is text a set's Writing Assistant learns from:
// written in place or imported from a draft of the same set.
type SocialSetWritingSample struct{ ent.Schema }

func (SocialSetWritingSample) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "social_set_writing_sample"}}
}

func (SocialSetWritingSample) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("social_set_id").StorageKey("socialSetId").Immutable(),
		field.String("text").StorageKey("text").Immutable(),
		field.Enum("source").StorageKey("source").Values("manual", "draft").Immutable(),
		field.String("source_draft_id").StorageKey("sourceDraftId").Optional().Nillable().Immutable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (SocialSetWritingSample) Indexes() []ent.Index {
	return []ent.Index{index.Fields("social_set_id", "created_at")}
}

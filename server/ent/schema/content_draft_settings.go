package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// ContentDraftSettings is a workspace's drafts preferences (RFC 013): the
// weekly posting slots its queue fills, whether a draft needs approval
// before it is scheduled, and whether its last editor may approve it. Times are in the workspace's time zone.
type ContentDraftSettings struct{ ent.Schema }

// QueueSlot is a weekly posting time: a weekday (0 is Sunday) and HH:MM.
type QueueSlot struct {
	Time    string `json:"time"`
	Weekday int    `json:"weekday"`
}

// DefaultQueueSlots gives each new publishing identity its own weekday schedule.
func DefaultQueueSlots() []QueueSlot {
	return []QueueSlot{
		{Weekday: 1, Time: "09:00"}, {Weekday: 2, Time: "09:00"}, {Weekday: 3, Time: "09:00"},
		{Weekday: 4, Time: "09:00"}, {Weekday: 5, Time: "09:00"},
	}
}

func (ContentDraftSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "content_draft_settings"}}
}

func (ContentDraftSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.JSON("posting_slots", []QueueSlot{}).StorageKey("postingSlots"),
		field.Bool("require_approval").StorageKey("requireApproval").Default(false),
		// When off, a draft's last editor cannot approve it.
		field.Bool("allow_self_approval").StorageKey("allowSelfApproval").Default(true),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

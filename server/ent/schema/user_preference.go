package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

// UserPreference is one person's preferences (RFC 024), keyed by the person
// so they follow them across workspaces and never change anyone else's view.
type UserPreference struct{ ent.Schema }

func (UserPreference) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "user_preference"}}
}

func (UserPreference) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("userId").Immutable(),
		// The display time zone; empty follows the browser.
		field.String("time_zone").StorageKey("timeZone").Optional().Nillable(),
		field.String("accent_color").StorageKey("accentColor").Default(""),
		field.Enum("theme").StorageKey("theme").Values("light", "dark", "system").Default("dark"),
		field.Enum("navigation").StorageKey("navigation").Values("compact", "dynamic", "expanded").Default("compact"),
		field.Enum("week_start").StorageKey("weekStart").Values("monday", "sunday").Default("monday"),
		// The clock times read on; auto follows the browser locale.
		field.Enum("time_format").StorageKey("timeFormat").Values("auto", "12h", "24h").Default("auto"),
		field.Enum("text_direction").StorageKey("textDirection").Values("ltr", "rtl").Default("ltr"),
		field.Bool("show_scrollbars").StorageKey("showScrollbars").Default(true),
		field.Bool("developer_mode").StorageKey("developerMode").Default(false),
		field.Bool("email_notifications").StorageKey("emailNotifications").Default(true),
		field.JSON("dismissed_tips", []string{}).StorageKey("dismissedTips").Default([]string{}),
		field.JSON("experiments", map[string]bool{}).StorageKey("experiments").Default(map[string]bool{}),
		field.Int("version").StorageKey("version").Default(1),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

// AccountDeletionRequest asks for a person's account to be deleted once its
// grace period ends; until then it can be cancelled.
type AccountDeletionRequest struct{ ent.Schema }

func (AccountDeletionRequest) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "account_deletion_request"}}
}

func (AccountDeletionRequest) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.Enum("status").StorageKey("status").Values("REQUESTED", "PROCESSING", "CANCELLED", "COMPLETED").Default("REQUESTED"),
		field.Time("requested_at").StorageKey("requestedAt").Default(time.Now).Immutable(),
		field.Time("execute_after").StorageKey("executeAfter").Immutable(),
		field.Time("cancelled_at").StorageKey("cancelledAt").Optional().Nillable(),
		field.Time("completed_at").StorageKey("completedAt").Optional().Nillable(),
	}
}

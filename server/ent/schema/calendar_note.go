package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// CalendarNote is a workspace's note on a calendar date. It is not a post: it
// references no draft or set, so it never publishes. Day is a date with no
// instant or zone, and reads as the same day in every zone.
type CalendarNote struct{ ent.Schema }

func (CalendarNote) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "calendar_note"}}
}

func (CalendarNote) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.Time("day").SchemaType(map[string]string{dialect.Postgres: "date"}).Immutable(),
		field.String("title"),
		field.Enum("color").Values("blue", "green", "red", "yellow", "purple", "orange"),
		field.String("created_by_user_id").StorageKey("createdByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (CalendarNote) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "day")}
}

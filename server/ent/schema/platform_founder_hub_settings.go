package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"time"
)

type PlatformFounderHubSettings struct{ ent.Schema }

func (PlatformFounderHubSettings) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_settings"}}
}

func (PlatformFounderHubSettings) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("device_id").StorageKey("deviceId").Default("").Immutable(),
		field.String("device_name").StorageKey("deviceName").Default(""),
		field.JSON("values", map[string]any{}).Default(map[string]any{}),
		field.Int("version").Default(1),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (PlatformFounderHubSettings) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id", "device_id").Unique()}
}

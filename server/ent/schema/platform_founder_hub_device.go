package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"time"
)

type PlatformFounderHubDevice struct{ ent.Schema }

func (PlatformFounderHubDevice) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_device"}}
}
func (PlatformFounderHubDevice) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("device_id").StorageKey("deviceId").Immutable(),
		field.String("name"),
		field.JSON("report", founderhub.DeviceReport{}),
		field.Time("reported_at").StorageKey("reportedAt").Default(time.Now),
	}
}
func (PlatformFounderHubDevice) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id", "device_id").Unique()}
}

type PlatformFounderHubDeviceCommand struct{ ent.Schema }

func (PlatformFounderHubDeviceCommand) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_founder_hub_device_command"}}
}
func (PlatformFounderHubDeviceCommand) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("device_id").StorageKey("deviceId").Immutable(),
		field.String("kind").Immutable(),
		field.String("argument").Immutable(),
		field.String("status").Default("pending"),
		field.String("error").Default(""),
		field.String("result").Default(""),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("expires_at").StorageKey("expiresAt").Immutable(),
	}
}
func (PlatformFounderHubDeviceCommand) Indexes() []ent.Index {
	return []ent.Index{index.Fields("user_id", "device_id", "status")}
}

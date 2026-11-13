package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"time"
)

type PlatformNotificationPolicy struct{ ent.Schema }

func (PlatformNotificationPolicy) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_notification_policy"}}
}
func (PlatformNotificationPolicy) Fields() []ent.Field {
	return []ent.Field{field.String("id").StorageKey("organizationId"),
		field.JSON("events", map[string]any{}).Default(map[string]any{}),
		field.JSON("availability", map[string]bool{}).Default(map[string]bool{"inApp": true, "email": true, "slack": true}),
		field.Int("generation").Default(1),
		field.String("slack_connection_id").Default(""),
		field.String("slack_channel_id").Default(""),
		field.String("slack_channel_name").Default(""),
		field.JSON("social_set_slack_channels", map[string]map[string]string{}).Default(map[string]map[string]string{}),
		field.Time("enabled_at").Default(time.Now),
		field.Time("updated_at").Default(time.Now)}
}

type PlatformNotificationPreference struct{ ent.Schema }

func (PlatformNotificationPreference) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_notification_preference"}}
}
func (PlatformNotificationPreference) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("organization_id").StorageKey("organizationId"),
		field.String("user_id").StorageKey("userId"),
		field.JSON("events", map[string]any{}).Default(map[string]any{}),
		// Per social set: activity kinds turned off for that set (RFC 024).
		field.JSON("social_sets", map[string]map[string]bool{}).Default(map[string]map[string]bool{}),
		field.Bool("slack_enabled").Default(true),
		field.JSON("social_set_channels", map[string]map[string]map[string]bool{}).Default(map[string]map[string]map[string]bool{}),
		field.Int("generation").Default(1),
		field.Time("updated_at").Default(time.Now)}
}

func (PlatformNotificationPreference) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id").Unique()}
}

type PlatformNotificationInbox struct{ ent.Schema }

func (PlatformNotificationInbox) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_notification_inbox"}}
}
func (PlatformNotificationInbox) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("organization_id").StorageKey("organizationId"),
		field.String("user_id").StorageKey("userId"),
		field.String("event_id"),
		field.String("kind"),
		field.String("resource_type"),
		field.String("resource_id"),
		field.String("description"),
		field.String("href"),
		field.Enum("category").Values("inbox", "activity").Default("activity"),
		field.Time("read_at").Optional().Nillable(),
		field.Time("archived_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now)}
}

func (PlatformNotificationInbox) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id", "created_at", "id"), index.Fields("organization_id", "user_id", "event_id").Unique(), index.Fields("created_at")}
}

type PlatformNotificationDelivery struct{ ent.Schema }

func (PlatformNotificationDelivery) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_notification_delivery"}}
}
func (PlatformNotificationDelivery) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("organization_id").StorageKey("organizationId"),
		field.String("event_id"),
		field.String("kind"),
		field.String("channel"),
		field.String("destination"),
		field.String("status").Default("PENDING"),
		field.Int("policy_generation").Default(1),
		field.Int("preference_generation").Default(1),
		field.String("connection_id").Default(""),
		field.String("claim_token").Default(""),
		field.Time("claimed_at").Optional().Nillable(),
		field.Time("send_started_at").Optional().Nillable(),
		field.Int("attempts").Default(0),
		field.Time("next_attempt_at").Default(time.Now),
		field.String("failure_code").Default(""), field.String("decision_code").Default("LEGACY"),
		field.String("provider_receipt").Default(""),
		field.String("encrypted_payload").Default("").Sensitive(),
		field.Time("created_at").Default(time.Now),
		field.Time("updated_at").Default(time.Now)}
}

func (PlatformNotificationDelivery) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "event_id", "channel", "destination").Unique(), index.Fields("status", "next_attempt_at"), index.Fields("created_at")}
}

type PlatformNotificationSeenAction struct{ ent.Schema }

func (PlatformNotificationSeenAction) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_notification_seen_action"}}
}
func (PlatformNotificationSeenAction) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("organization_id").StorageKey("organizationId"),
		field.String("user_id").StorageKey("userId"),
		field.String("request_key"),
		field.String("request_fingerprint").Default(""),
		field.Int("deleted_count").Default(0),
		field.Time("created_at").Default(time.Now)}
}

func (PlatformNotificationSeenAction) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id", "request_key").Unique()}
}

type PlatformSlackInstallation struct{ ent.Schema }

func (PlatformSlackInstallation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_slack_installation"}}
}
func (PlatformSlackInstallation) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("app_id"),
		field.String("team_id"),
		field.String("enterprise_id").Default(""),
		field.String("team_name"),
		field.String("encrypted_credentials").Sensitive(),
		field.Strings("scopes"),
		field.Time("expires_at").Optional().Nillable(),
		field.String("health").Default("CONNECTED"),
		field.String("refresh_claim").Default(""),
		field.Time("refresh_started_at").Optional().Nillable(),
		field.Time("checked_at").Optional().Nillable(),
		field.Time("created_at").Default(time.Now),
		field.Time("updated_at").Default(time.Now)}
}

func (PlatformSlackInstallation) Indexes() []ent.Index {
	return []ent.Index{index.Fields("app_id", "team_id", "enterprise_id").Unique()}
}

type PlatformSlackConnection struct{ ent.Schema }

func (PlatformSlackConnection) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_slack_connection"}}
}
func (PlatformSlackConnection) Fields() []ent.Field {
	return []ent.Field{field.String("id"),
		field.String("organization_id").StorageKey("organizationId"),
		field.String("installation_id"),
		field.String("legacy_social_id").Default(""),
		field.Time("created_at").Default(time.Now)}
}

func (PlatformSlackConnection) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "installation_id").Unique()}
}

type PlatformSlackPacing struct{ ent.Schema }

func (PlatformSlackPacing) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_slack_pacing"}}
}
func (PlatformSlackPacing) Fields() []ent.Field {
	return []ent.Field{field.String("id"), field.String("installation_id"), field.String("channel_id"), field.Time("next_at")}
}

// PlatformSlackPersonalConnection binds one authorizing Slack user to a current member.
type PlatformSlackPersonalConnection struct{ ent.Schema }

func (PlatformSlackPersonalConnection) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "platform_slack_personal_connection"}}
}
func (PlatformSlackPersonalConnection) Fields() []ent.Field {
	return []ent.Field{field.String("id"), field.String("organization_id").StorageKey("organizationId"), field.String("user_id").StorageKey("userId"), field.String("member_id"), field.String("installation_id"), field.String("slack_user_id"), field.Time("created_at").Default(time.Now)}
}
func (PlatformSlackPersonalConnection) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "user_id").Unique(), index.Fields("installation_id")}
}

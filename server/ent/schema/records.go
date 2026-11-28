package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Apikey is a Better Auth organization API key. The backend reads it to
// recheck a key the web facade already verified.
type Apikey struct{ ent.Schema }

func (Apikey) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "apikey"}}
}

func (Apikey) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("config_id").StorageKey("configId").Default("default"),
		field.String("name").StorageKey("name").Optional().Nillable(),
		field.String("start").StorageKey("start").Optional().Nillable(),
		field.String("reference_id").StorageKey("referenceId"),
		field.String("prefix").StorageKey("prefix").Optional().Nillable(),
		field.String("key").StorageKey("key").Sensitive(),
		field.Bool("enabled").StorageKey("enabled").Optional().Nillable(),
		field.Time("expires_at").StorageKey("expiresAt").Optional().Nillable(),
		field.Time("last_request").StorageKey("lastRequest").Optional().Nillable(),
		field.String("permissions").StorageKey("permissions").Optional().Nillable(),
		// Better Auth's JSON metadata; agent keys record the OAuth client here.
		field.String("metadata").StorageKey("metadata").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt"),
		field.Time("updated_at").StorageKey("updatedAt"),
	}
}

func (Apikey) Indexes() []ent.Index {
	return []ent.Index{index.Fields("reference_id")}
}

// AuditRetentionPolicy is a workspace's audit retention and legal hold.
type AuditRetentionPolicy struct{ ent.Schema }

func (AuditRetentionPolicy) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "audit_retention_policy"}}
}

func (AuditRetentionPolicy) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("organizationId").Immutable(),
		field.Int("retention_days").StorageKey("retentionDays").Default(90),
		field.Bool("legal_hold").StorageKey("legalHold").Default(false),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

// BillingEntitlementEvent deduplicates billing provider entitlement events.
type BillingEntitlementEvent struct{ ent.Schema }

func (BillingEntitlementEvent) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "billing_entitlement_event"}}
}

func (BillingEntitlementEvent) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("provider").StorageKey("provider"),
		field.String("event_id").StorageKey("eventId"),
		field.String("event_type").StorageKey("eventType"),
		field.Int("entitlement_version").StorageKey("entitlementVersion"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (BillingEntitlementEvent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("provider", "event_id").Unique(),
		index.Fields("organization_id", "created_at"),
	}
}

// ScreenshotCache maps a captured URL to its stored screenshot.
type ScreenshotCache struct{ ent.Schema }

func (ScreenshotCache) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "screenshot_cache"}}
}

func (ScreenshotCache) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("url_hash").StorageKey("urlHash").Unique(),
		field.String("url").StorageKey("url"),
		field.String("cloudinary_public_id").StorageKey("cloudinaryPublicId").Unique(),
		field.String("cloudinary_url").StorageKey("cloudinaryUrl"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ScreenshotCache) Indexes() []ent.Index {
	return []ent.Index{index.Fields("created_at")}
}

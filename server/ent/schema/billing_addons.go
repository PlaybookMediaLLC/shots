package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// WorkspaceAddon holds a workspace's paid add-on subscription state (such as
// "x_links" for keeping links in X posts). Kept separate from
// WorkspaceEntitlement so add-on lifecycle never clobbers base-plan overrides
// and works alongside monthly, annual, or invoiced Enterprise base plans.
type WorkspaceAddon struct{ ent.Schema }

func (WorkspaceAddon) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "workspace_addon"}}
}

func (WorkspaceAddon) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("addon_key").StorageKey("addonKey").Immutable(),
		field.String("status").StorageKey("status").Default("canceled"),
		field.String("provider").StorageKey("provider").Default("stripe"),
		field.String("external_subscription_id").StorageKey("externalSubscriptionId").Optional().Nillable(),
		// Nullable for custom unlimited Enterprise agreements; defaults to 40 for x_links.
		field.Int("quota_limit").StorageKey("quotaLimit").Optional().Nillable(),
		field.Time("current_period_start").StorageKey("currentPeriodStart").Optional().Nillable(),
		field.Time("current_period_end").StorageKey("currentPeriodEnd").Optional().Nillable(),
		field.Bool("cancel_at_period_end").StorageKey("cancelAtPeriodEnd").Default(false),
		field.Time("grace_until").StorageKey("graceUntil").Optional().Nillable(),
		field.Int("version").StorageKey("version").Default(1),
		field.Time("last_synced_at").StorageKey("lastSyncedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (WorkspaceAddon) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "addon_key").Unique(),
		index.Fields("external_subscription_id"),
	}
}

// XLinkPostUsage is the durable rolling 30-day ledger of X posts sent with
// links under the x_links add-on. One row per X tweet mutation (root, reply,
// first_comment, plug, quote), deduplicated by (organizationId, idempotencyKey)
// so Temporal retries never double-charge.
type XLinkPostUsage struct{ ent.Schema }

func (XLinkPostUsage) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "x_link_post_usage"}}
}

func (XLinkPostUsage) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("scheduled_post_id").StorageKey("scheduledPostId").Optional().Nillable().Immutable(),
		field.String("part_key").StorageKey("partKey").Immutable(),
		field.String("idempotency_key").StorageKey("idempotencyKey").Immutable(),
		field.Int("link_count").StorageKey("linkCount").Positive(),
		field.Time("consumed_at").StorageKey("consumedAt").Default(time.Now),
		field.Time("refunded_at").StorageKey("refundedAt").Optional().Nillable(),
	}
}

func (XLinkPostUsage) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "idempotency_key").Unique(),
		index.Fields("organization_id", "consumed_at").Annotations(entsql.IndexWhere(`"refundedAt" IS NULL`)),
	}
}

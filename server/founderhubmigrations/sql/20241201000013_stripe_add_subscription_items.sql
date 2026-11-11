create table if not exists "founder_hub_billing"."subscription_items" (
  "id" text primary key,
  "object" text,
  "billing_thresholds" jsonb,
  "created" integer,
  "deleted" boolean,
  "metadata" jsonb,
  "quantity" integer,
  "price" text references "founder_hub_billing"."prices",
  "subscription" text references "founder_hub_billing"."subscriptions",
  "tax_rates" jsonb
);
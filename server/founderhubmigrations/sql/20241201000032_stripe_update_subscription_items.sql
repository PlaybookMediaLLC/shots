ALTER TABLE "founder_hub_billing"."subscription_items"
ADD COLUMN IF NOT EXISTS "current_period_end" integer,
ADD COLUMN IF NOT EXISTS "current_period_start" integer;

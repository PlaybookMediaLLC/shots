ALTER TABLE "founder_hub_billing"."disputes" ADD COLUMN IF NOT EXISTS payment_intent TEXT;

CREATE INDEX IF NOT EXISTS stripe_dispute_created_idx ON "founder_hub_billing"."disputes" USING btree (created);
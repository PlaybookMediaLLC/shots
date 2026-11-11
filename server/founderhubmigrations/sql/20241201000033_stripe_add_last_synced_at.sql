-- Add last_synced_at column to all Stripe tables for tracking sync status

-- Charges
alter table "founder_hub_billing"."charges"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Coupons
alter table "founder_hub_billing"."coupons"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Credit Notes
alter table "founder_hub_billing"."credit_notes"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Customers
alter table "founder_hub_billing"."customers"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Disputes
alter table "founder_hub_billing"."disputes"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Early Fraud Warnings
alter table "founder_hub_billing"."early_fraud_warnings"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Events
alter table "founder_hub_billing"."events"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Invoices
alter table "founder_hub_billing"."invoices"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payment Intents
alter table "founder_hub_billing"."payment_intents"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payment Methods
alter table "founder_hub_billing"."payment_methods"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Payouts
alter table "founder_hub_billing"."payouts"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Plans
alter table "founder_hub_billing"."plans"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Prices
alter table "founder_hub_billing"."prices"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Products
alter table "founder_hub_billing"."products"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Refunds
alter table "founder_hub_billing"."refunds"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Reviews
alter table "founder_hub_billing"."reviews"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Setup Intents
alter table "founder_hub_billing"."setup_intents"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscription Items
alter table "founder_hub_billing"."subscription_items"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscription Schedules
alter table "founder_hub_billing"."subscription_schedules"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Subscriptions
alter table "founder_hub_billing"."subscriptions"
add column IF NOT EXISTS "last_synced_at" timestamptz;

-- Tax IDs
alter table "founder_hub_billing"."tax_ids"
add column IF NOT EXISTS "last_synced_at" timestamptz;

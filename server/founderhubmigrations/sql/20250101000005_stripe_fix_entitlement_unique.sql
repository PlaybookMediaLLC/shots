alter table "founder_hub_billing"."active_entitlements"
    drop constraint if exists "active_entitlements_lookup_key_key";

alter table "founder_hub_billing"."active_entitlements"
    add constraint "active_entitlements_customer_lookup_key_key"
    unique ("customer", "lookup_key");

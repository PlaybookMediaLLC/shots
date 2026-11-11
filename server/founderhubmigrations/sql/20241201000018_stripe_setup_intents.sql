create table if not exists "founder_hub_billing"."setup_intents" (
    id text primary key,
    object text,
    created integer,
    customer text,
    description text,
    payment_method text,
    status text,
    usage text,
    cancellation_reason text,
    latest_attempt text,
    mandate text,
    single_use_mandate text,
    on_behalf_of text
);

CREATE INDEX stripe_setup_intents_customer_idx ON "founder_hub_billing"."setup_intents" USING btree (customer);
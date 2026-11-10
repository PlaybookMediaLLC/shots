create table if not exists
  "founder_hub_billing"."tax_ids" (
    "id" text primary key,
    "object" text,
    "country" text,
    "customer" text,
    "type" text,
    "value" text,
    "created" integer not null,
    "livemode" boolean,
    "owner" jsonb
  );

create index stripe_tax_ids_customer_idx on "founder_hub_billing"."tax_ids" using btree (customer);
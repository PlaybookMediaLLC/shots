create table
    if not exists "founder_hub_billing"."refunds" (
        "id" text primary key,
        object text,
        amount integer,
        balance_transaction text,
        charge text,
        created integer,
        currency text,
        destination_details jsonb,
        metadata jsonb,
        payment_intent text,
        reason text,
        receipt_number text,
        source_transfer_reversal text,
        status text,
        transfer_reversal text,
        updated_at timestamptz default timezone('utc'::text, now()) not null
    );

create index stripe_refunds_charge_idx on "founder_hub_billing"."refunds" using btree (charge);

create index stripe_refunds_payment_intent_idx on "founder_hub_billing"."refunds" using btree (payment_intent);

create trigger handle_updated_at
    before update
    on founder_hub_billing.refunds
    for each row
    execute procedure set_updated_at();

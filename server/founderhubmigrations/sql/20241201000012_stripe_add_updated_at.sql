create or replace function set_updated_at() returns trigger
    language plpgsql
as
$$
begin
  new.updated_at = now();
  return NEW;
end;
$$;

alter function set_updated_at() OWNER TO shots_hub_owner;

alter table founder_hub_billing.subscriptions
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.subscriptions
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.products
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.products
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.customers
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.customers
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.prices
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.prices
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.invoices
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.invoices
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.charges
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.charges
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.coupons
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.coupons
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.disputes
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.disputes
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.events
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.events
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.payouts
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.payouts
    for each row
    execute procedure set_updated_at();

alter table founder_hub_billing.plans
    add updated_at timestamptz default timezone('utc'::text, now()) not null;

create trigger handle_updated_at
    before update
    on founder_hub_billing.plans
    for each row
    execute procedure set_updated_at();

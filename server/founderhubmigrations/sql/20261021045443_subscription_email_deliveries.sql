CREATE TABLE founder_hub_private.subscription_email_deliveries (
    delivery_key text PRIMARY KEY,
    payload jsonb NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    sent_at timestamptz
);
ALTER TABLE founder_hub_private.subscription_email_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON founder_hub_private.subscription_email_deliveries FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT SELECT, INSERT, UPDATE ON founder_hub_private.subscription_email_deliveries TO shots_hub_service_role;

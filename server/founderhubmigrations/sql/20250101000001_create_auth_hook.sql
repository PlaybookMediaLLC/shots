CREATE OR REPLACE FUNCTION founder_hub.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  claims jsonb;
  entitlements jsonb := '[]'::jsonb;
BEGIN
  SELECT
    COALESCE(
      jsonb_agg(ae.lookup_key ORDER BY ae.lookup_key)
        FILTER (WHERE ae.lookup_key IS NOT NULL),
      '[]'::jsonb
    )
  INTO entitlements
  FROM founder_hub.profiles p
  JOIN founder_hub_billing.active_entitlements ae
    ON ae.customer = p.stripe_customer_id
  WHERE p.id = (event->>'user_id')::uuid;

  claims := event->'claims';
  claims := jsonb_set(claims, '{entitlements}', entitlements);
  event := jsonb_set(event, '{claims}', claims);

  RETURN event;
END;
$$;

GRANT USAGE ON SCHEMA founder_hub TO shots_hub_supabase_auth_admin;

GRANT EXECUTE ON FUNCTION founder_hub.custom_access_token_hook TO shots_hub_supabase_auth_admin;

REVOKE EXECUTE ON FUNCTION founder_hub.custom_access_token_hook FROM shots_hub_authenticated, shots_hub_anon, public;

GRANT SELECT ON TABLE founder_hub.profiles TO shots_hub_supabase_auth_admin;

CREATE POLICY "Allow auth admin to read profiles"
ON founder_hub.profiles
AS PERMISSIVE FOR SELECT
TO shots_hub_supabase_auth_admin
USING (true);

GRANT USAGE ON SCHEMA founder_hub_billing TO shots_hub_supabase_auth_admin;
GRANT SELECT ON TABLE founder_hub_billing.active_entitlements TO shots_hub_supabase_auth_admin;

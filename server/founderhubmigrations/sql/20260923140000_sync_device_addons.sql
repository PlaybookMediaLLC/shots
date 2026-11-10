BEGIN;

SET LOCAL lock_timeout = '30s';

-- Extra sync device slots are sold as a recurring add-on item on the user's
-- personal Pro subscription. Each unit of the add-on price adds one slot on
-- top of the plan's included allowance.
CREATE OR REPLACE FUNCTION founder_hub_private.sync_device_addon_count(p_actor_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(SUM(item.quantity), 0)::integer
  FROM founder_hub.profiles AS profile
  JOIN founder_hub_billing.subscriptions AS subscription
    ON subscription.customer = profile.stripe_customer_id
  JOIN founder_hub_billing.subscription_items AS item
    ON item.subscription = subscription.id
  JOIN founder_hub_billing.prices AS price
    ON price.id = item.price
  WHERE profile.id = p_actor_user_id
    AND profile.stripe_customer_id IS NOT NULL
    AND subscription.status IN ('active', 'trialing')
    AND COALESCE(item.deleted, false) = false
    AND price.lookup_key IN (
      'hyprnote_sync_device_addon_monthly',
      'hyprnote_sync_device_addon_yearly'
    );
$$;

REVOKE ALL ON FUNCTION founder_hub_private.sync_device_addon_count(uuid)
  FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub_private.sync_device_addon_count(uuid) TO shots_hub_service_role;

CREATE OR REPLACE FUNCTION founder_hub_private.sync_device_limit(p_actor_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT (
    CASE WHEN EXISTS (
      SELECT 1
      FROM founder_hub.workspace_memberships AS membership
      WHERE membership.user_id = p_actor_user_id
        AND membership.deleted_at IS NULL
        AND founder_hub_private.workspace_capabilities(membership.workspace_id)
          @> ARRAY['team.shared_notes']::text[]
    ) THEN 5 ELSE 3 END
  ) + founder_hub_private.sync_device_addon_count(p_actor_user_id);
$$;

REVOKE ALL ON FUNCTION founder_hub_private.sync_device_limit(uuid)
  FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub_private.sync_device_limit(uuid) TO shots_hub_service_role;

COMMIT;

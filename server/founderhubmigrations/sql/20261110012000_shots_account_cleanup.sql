CREATE FUNCTION founder_hub_private.require_shots_account_available() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.platform_founder_hub_account_available(NEW.id) THEN
    RAISE EXCEPTION 'Shots account is unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION founder_hub_private.require_shots_account_available() FROM PUBLIC, shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;
CREATE TRIGGER require_shots_account_available BEFORE INSERT OR UPDATE ON founder_hub_identity.users
FOR EACH ROW EXECUTE FUNCTION founder_hub_private.require_shots_account_available();

CREATE FUNCTION founder_hub.purge_shots_account_replica(p_owner_user_id uuid, p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_ids uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_user_id::text, 170001));
  SELECT e2ee_workspace_ids INTO v_workspace_ids FROM founder_hub_private.account_deletion_jobs
  WHERE owner_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Validation and the checkpoint roll back together if any replica deletion fails.
  PERFORM founder_hub.mark_account_deletion_e2ee_purged(p_owner_user_id, p_lease_id, v_workspace_ids);
  PERFORM 1 FROM founder_hub.workspaces WHERE id = ANY(v_workspace_ids) ORDER BY id FOR UPDATE;
  DELETE FROM founder_hub.e2ee_replica_receipts WHERE workspace_id = ANY(v_workspace_ids);
  DELETE FROM founder_hub.e2ee_freshness_events WHERE workspace_id = ANY(v_workspace_ids);
  RETURN true;
END;
$$;

CREATE FUNCTION founder_hub.finish_shots_account_deletion(p_owner_user_id uuid, p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_workspace_ids uuid[];
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_user_id::text, 170001));
  SELECT e2ee_workspace_ids INTO v_workspace_ids FROM founder_hub_private.account_deletion_jobs
  WHERE owner_user_id = p_owner_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM founder_hub.mark_account_deletion_e2ee_purged(p_owner_user_id, p_lease_id, v_workspace_ids);
  PERFORM 1 FROM founder_hub.workspaces WHERE id = ANY(v_workspace_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM founder_hub.e2ee_replica_receipts WHERE workspace_id = ANY(v_workspace_ids))
    OR EXISTS (SELECT 1 FROM founder_hub.e2ee_freshness_events WHERE workspace_id = ANY(v_workspace_ids)) THEN
    RAISE EXCEPTION 'Shots replica cleanup is incomplete' USING ERRCODE = '55000';
  END IF;
  DELETE FROM founder_hub_identity.users WHERE id = p_owner_user_id;
  RETURN founder_hub.finish_account_deletion(p_owner_user_id, p_lease_id);
END;
$$;
REVOKE ALL ON FUNCTION founder_hub.purge_shots_account_replica(uuid, uuid), founder_hub.finish_shots_account_deletion(uuid, uuid)
  FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub.purge_shots_account_replica(uuid, uuid), founder_hub.finish_shots_account_deletion(uuid, uuid)
  TO shots_hub_service_role;

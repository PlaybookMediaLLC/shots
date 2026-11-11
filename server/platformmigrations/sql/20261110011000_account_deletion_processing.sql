ALTER TABLE account_deletion_request DROP CONSTRAINT account_deletion_request_status_check;
ALTER TABLE account_deletion_request ADD CONSTRAINT account_deletion_request_status_check
  CHECK (status IN ('REQUESTED', 'PROCESSING', 'CANCELLED', 'COMPLETED'));
DROP INDEX account_deletion_request_open_key;
CREATE UNIQUE INDEX account_deletion_request_open_key ON account_deletion_request ("userId")
  WHERE status IN ('REQUESTED', 'PROCESSING');

CREATE TRIGGER platform_founder_hub_authority_changed AFTER INSERT OR UPDATE OR DELETE ON account_deletion_request
FOR EACH STATEMENT EXECUTE FUNCTION platform_founder_hub_authority_changed();

CREATE FUNCTION platform_account_accepts_session() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Serialize new credentials with the irreversible deletion claim.
  PERFORM 1 FROM public."user" WHERE id = NEW."userId" FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM public.account_deletion_request WHERE "userId" = NEW."userId" AND status IN ('PROCESSING', 'COMPLETED')) THEN
    RAISE EXCEPTION 'account deletion is in progress' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_account_accepts_session BEFORE INSERT OR UPDATE ON session
FOR EACH ROW EXECUTE FUNCTION platform_account_accepts_session();
CREATE TRIGGER platform_account_accepts_membership BEFORE INSERT OR UPDATE ON member
FOR EACH ROW EXECUTE FUNCTION platform_account_accepts_session();

CREATE FUNCTION platform_founder_hub_account_available(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_founder_hub_user AS identity
    WHERE identity."accountUserId" = p_user_id AND NOT EXISTS (
      SELECT 1 FROM public.account_deletion_request AS deletion
      WHERE deletion."userId" = identity."userId" AND deletion.status IN ('PROCESSING', 'COMPLETED')
    )
  )
$$;
REVOKE ALL ON FUNCTION platform_founder_hub_account_available(uuid) FROM PUBLIC;

CREATE TABLE platform_founder_hub_revision (
  id TEXT PRIMARY KEY CHECK (id = 'authority'),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO platform_founder_hub_revision (id) VALUES ('authority');

INSERT INTO platform_founder_hub_user ("userId", "accountUserId")
SELECT id, gen_random_uuid() FROM "user" ON CONFLICT ("userId") DO NOTHING;
INSERT INTO platform_founder_hub_workspace ("organizationId", "workspaceId")
SELECT id, gen_random_uuid() FROM organization ON CONFLICT ("organizationId") DO NOTHING;

CREATE FUNCTION platform_founder_hub_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'user' THEN
    INSERT INTO platform_founder_hub_user ("userId", "accountUserId") VALUES (NEW.id, gen_random_uuid());
  ELSE
    INSERT INTO platform_founder_hub_workspace ("organizationId", "workspaceId") VALUES (NEW.id, gen_random_uuid());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_founder_hub_user_identity AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION platform_founder_hub_identity();
CREATE TRIGGER platform_founder_hub_workspace_identity AFTER INSERT ON organization
FOR EACH ROW EXECUTE FUNCTION platform_founder_hub_identity();

-- A transactional counter orders committed authority changes; a sequence would not.
CREATE FUNCTION platform_founder_hub_authority_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE platform_founder_hub_revision SET revision = revision + 1 WHERE id = 'authority';
  RETURN NULL;
END;
$$;
DO $$
DECLARE authority_table TEXT;
BEGIN
  FOREACH authority_table IN ARRAY ARRAY[
    'user', 'organization', 'member', 'permission_group', 'permission_group_member',
    'workspace_entitlement', 'workspace_deletion', 'platform_founder_hub_user', 'platform_founder_hub_workspace'
  ] LOOP
    EXECUTE format('CREATE TRIGGER platform_founder_hub_authority_changed AFTER INSERT OR UPDATE OR DELETE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION platform_founder_hub_authority_changed()', authority_table);
  END LOOP;
END;
$$;

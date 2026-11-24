ALTER TABLE platform_release_readiness ADD COLUMN "claimImportProgress" jsonb;

-- Provider writers fence retained evidence in the same transaction as access
-- and content changes. Queue delivery cannot keep old support admissible.
CREATE FUNCTION platform_evidence_binding_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id text;
BEGIN
 IF OLD."changeSequence" IS DISTINCT FROM NEW."changeSequence" THEN
  FOR source_id IN SELECT id FROM platform_evidence_source
   WHERE "organizationId"=NEW."organizationId" AND "sourceBindingId"=NEW.id ORDER BY id FOR UPDATE
  LOOP
   UPDATE platform_evidence_source SET "changeSequence"="changeSequence"+1 WHERE id=source_id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_binding_fence AFTER UPDATE OF "changeSequence" ON platform_release_source_binding
 FOR EACH ROW EXECUTE FUNCTION platform_evidence_binding_fence();

CREATE FUNCTION platform_evidence_access_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding_id text;
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
  FOR binding_id IN SELECT id FROM platform_release_source_binding
   WHERE "organizationId"=NEW."organizationId" AND "sourceAppId"=NEW.id ORDER BY id FOR UPDATE
  LOOP
   UPDATE platform_release_source_binding SET "changeSequence"="changeSequence"+1, "updatedAt"=now() WHERE id=binding_id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_source_access_fence AFTER UPDATE OF status ON source_app
 FOR EACH ROW EXECUTE FUNCTION platform_evidence_access_fence();

CREATE FUNCTION platform_evidence_installation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding_id text;
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
  FOR binding_id IN SELECT b.id FROM platform_release_source_binding b
   JOIN source_app s ON s.id=b."sourceAppId" AND s."organizationId"=b."organizationId"
   WHERE s."githubInstallationId"=NEW.id ORDER BY b."organizationId", b.id FOR UPDATE OF b
  LOOP
   UPDATE platform_release_source_binding SET "changeSequence"="changeSequence"+1, "updatedAt"=now() WHERE id=binding_id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_installation_access_fence AFTER UPDATE OF status ON github_installation
 FOR EACH ROW EXECUTE FUNCTION platform_evidence_installation_fence();

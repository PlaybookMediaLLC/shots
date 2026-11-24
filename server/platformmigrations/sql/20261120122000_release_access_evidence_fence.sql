-- Access changes are evidence revisions, not synthetic provider observations.
-- Keep the binding's observed event/change sequence invariant intact.
CREATE OR REPLACE FUNCTION platform_evidence_access_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id text;
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
  FOR source_id IN SELECT e.id FROM platform_evidence_source e
   JOIN platform_release_source_binding b ON b.id=e."sourceBindingId" AND b."organizationId"=e."organizationId"
   WHERE b."organizationId"=NEW."organizationId" AND b."sourceAppId"=NEW.id ORDER BY e.id FOR UPDATE OF e
  LOOP
   UPDATE platform_evidence_source SET "changeSequence"="changeSequence"+1 WHERE id=source_id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION platform_evidence_installation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id text;
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
  FOR source_id IN SELECT e.id FROM platform_evidence_source e
   JOIN platform_release_source_binding b ON b.id=e."sourceBindingId" AND b."organizationId"=e."organizationId"
   JOIN source_app s ON s.id=b."sourceAppId" AND s."organizationId"=b."organizationId"
   WHERE s."githubInstallationId"=NEW.id ORDER BY e."organizationId", e.id FOR UPDATE OF e
  LOOP
   UPDATE platform_evidence_source SET "changeSequence"="changeSequence"+1 WHERE id=source_id;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

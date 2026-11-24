SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE platform_release_kit (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "currentRevisionId" text,
    "approvedRevisionId" text,
    "lastVersion" bigint NOT NULL DEFAULT 0 CHECK ("lastVersion" >= 0),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);

CREATE TABLE platform_release_kit_revision (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kitId" text NOT NULL,
    "version" bigint NOT NULL CHECK ("version" > 0),
    "qualificationRevisionId" text NOT NULL,
    "approverUserId" text NOT NULL,
    "requestedByUserId" text NOT NULL,
    "state" text NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT', 'BUILDING', 'REVIEWABLE', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN', 'FAILED')),
    "manifest" jsonb NOT NULL,
    "manifestSha256" text NOT NULL DEFAULT '',
    "manifestCanonical" text NOT NULL DEFAULT '',
    "preparationJobId" text,
    "failureCode" text NOT NULL DEFAULT '',
    "preparedAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId", "kitId", "id"),
    UNIQUE ("organizationId", "kitId", "version"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);

CREATE TABLE platform_kit_artifact_revision (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kind" text NOT NULL CHECK ("kind" IN ('FACT_SHEET', 'SALES_NOTES', 'CS_NOTES', 'ANNOUNCEMENT', 'FAQ', 'SCREENSHOT')),
    "audienceId" text NOT NULL,
    "classification" text NOT NULL CHECK ("classification" IN ('INTERNAL_MATERIAL', 'CUSTOMER_CLEARED')),
    "snapshot" jsonb NOT NULL,
    "snapshotSha256" text NOT NULL,
    "claimLinks" jsonb NOT NULL,
    "claimMapSha256" text NOT NULL,
    "outputKey" text,
    "outputSha256" text,
    "outputBytes" bigint NOT NULL DEFAULT 0 CHECK ("outputBytes" >= 0),
    "mediaType" text NOT NULL DEFAULT '',
    "rendererVersion" text NOT NULL DEFAULT '',
    "preparedAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);

CREATE TABLE platform_kit_artifact_claim (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "artifactRevisionId" text NOT NULL,
    "nodeId" text NOT NULL,
    "claimId" text NOT NULL,
    "claimVersionId" text NOT NULL,
    "supportSetId" text,
    "verificationId" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "artifactRevisionId", "nodeId", "claimVersionId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX kit_artifact_claim_lookup_0 ON platform_kit_artifact_claim ("organizationId", "claimVersionId", "artifactRevisionId");

CREATE TABLE platform_kit_member (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kitRevisionId" text NOT NULL,
    "artifactRevisionId" text NOT NULL,
    "audienceId" text NOT NULL,
    "requirementId" text NOT NULL,
    "displayOrder" integer NOT NULL CHECK ("displayOrder" >= 0),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "kitRevisionId", "artifactRevisionId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX kit_member_lookup_0 ON platform_kit_member ("organizationId", "artifactRevisionId", "kitRevisionId");

CREATE TABLE platform_kit_source_pin (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kitRevisionId" text NOT NULL,
    "sourceId" text NOT NULL,
    "acknowledgedSequence" bigint NOT NULL CHECK ("acknowledgedSequence" >= 0),
    "evidenceVersionIds" jsonb NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "kitRevisionId", "sourceId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX kit_source_pin_lookup_0 ON platform_kit_source_pin ("organizationId", "sourceId", "kitRevisionId");

CREATE TABLE platform_kit_review_decision (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kitRevisionId" text NOT NULL,
    "reviewType" text NOT NULL CHECK ("reviewType" IN ('CONTENT_COVERAGE', 'FINAL_APPROVAL')),
    "decision" text NOT NULL CHECK ("decision" IN ('APPROVE', 'REJECT', 'WITHDRAW')),
    "manifestSha256" text NOT NULL,
    "dependencyToken" text NOT NULL,
    "policyVersion" integer NOT NULL CHECK ("policyVersion" > 0),
    "humanUserId" text NOT NULL,
    "sessionId" text NOT NULL,
    "reason" text NOT NULL,
    "assertionsConfirmed" boolean NOT NULL DEFAULT false,
    "screenshotsConfirmed" boolean NOT NULL DEFAULT false,
    "audienceConfirmed" boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX kit_review_decision_lookup_0 ON platform_kit_review_decision ("organizationId", "kitRevisionId", "reviewType", "createdAt", "id");

CREATE TABLE platform_kit_export (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL,
    "releaseId" text NOT NULL,
    "kitRevisionId" text NOT NULL,
    "audienceIds" jsonb NOT NULL,
    "audienceScope" text NOT NULL,
    "exportVersion" integer NOT NULL DEFAULT 1 CHECK ("exportVersion" > 0),
    "requestedByUserId" text NOT NULL,
    "state" text NOT NULL DEFAULT 'BUILDING' CHECK ("state" IN ('BUILDING', 'READY', 'FAILED')),
    "objectKey" text,
    "sha256" text,
    "bytes" bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    "fileIndex" jsonb NOT NULL,
    "failureCode" text NOT NULL DEFAULT '',
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "kitRevisionId", "audienceScope", "exportVersion"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);

ALTER TABLE platform_release_kit
    ADD FOREIGN KEY ("organizationId", "releaseId", id, "currentRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", "kitId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", id, "approvedRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", "kitId", id) ON DELETE RESTRICT;
ALTER TABLE platform_release_kit_revision
    ADD FOREIGN KEY ("organizationId", "releaseId", "kitId") REFERENCES platform_release_kit("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "qualificationRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD CHECK ("manifestSha256" = '' OR "manifestSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK (jsonb_typeof(manifest) = 'object');
ALTER TABLE platform_kit_artifact_revision
    ADD CHECK ("snapshotSha256" ~ '^[0-9a-f]{64}$' AND "claimMapSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK (octet_length(snapshot::text) <= 2097152 AND jsonb_typeof(snapshot) = 'object'),
    ADD CHECK (jsonb_typeof("claimLinks") = 'array' AND jsonb_array_length("claimLinks") <= 100),
    ADD CHECK (("preparedAt" IS NULL AND "outputKey" IS NULL AND "outputSha256" IS NULL AND "outputBytes" = 0) OR
        ("outputKey" IS NOT NULL AND "outputSha256" ~ '^[0-9a-f]{64}$' AND "outputBytes" BETWEEN 1 AND 104857600));
ALTER TABLE platform_kit_artifact_claim
    ADD FOREIGN KEY ("organizationId", "releaseId", "artifactRevisionId") REFERENCES platform_kit_artifact_revision("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId") REFERENCES platform_release_claim_version("organizationId", "releaseId", "claimId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId", "supportSetId") REFERENCES platform_claim_support_set("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId", "verificationId") REFERENCES platform_claim_verification("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT;
ALTER TABLE platform_kit_member
    ADD FOREIGN KEY ("organizationId", "releaseId", "kitRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "artifactRevisionId") REFERENCES platform_kit_artifact_revision("organizationId", "releaseId", id) ON DELETE RESTRICT;
ALTER TABLE platform_kit_source_pin
    ADD FOREIGN KEY ("organizationId", "releaseId", "kitRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "sourceId") REFERENCES platform_evidence_source("organizationId", id) ON DELETE RESTRICT,
    ADD CHECK (jsonb_typeof("evidenceVersionIds") = 'array' AND jsonb_array_length("evidenceVersionIds") BETWEEN 1 AND 2000);
ALTER TABLE platform_kit_review_decision
    ADD FOREIGN KEY ("organizationId", "releaseId", "kitRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD CHECK ("manifestSha256" ~ '^[0-9a-f]{64}$' AND "dependencyToken" ~ '^[0-9a-f]{64}$' AND octet_length(reason) BETWEEN 1 AND 8192),
    ADD CHECK ("reviewType" <> 'CONTENT_COVERAGE' OR decision <> 'APPROVE' OR ("assertionsConfirmed" AND "screenshotsConfirmed" AND "audienceConfirmed"));
ALTER TABLE platform_kit_export
    ADD FOREIGN KEY ("organizationId", "releaseId", "kitRevisionId") REFERENCES platform_release_kit_revision("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD CHECK (jsonb_typeof("audienceIds") = 'array' AND jsonb_array_length("audienceIds") BETWEEN 1 AND 20),
    ADD CHECK (state <> 'READY' OR ("objectKey" IS NOT NULL AND sha256 ~ '^[0-9a-f]{64}$'));

CREATE FUNCTION platform_kit_revision_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['state','manifest','manifestSha256','manifestCanonical','preparationJobId','failureCode','preparedAt'])
        <> (to_jsonb(OLD) - ARRAY['state','manifest','manifestSha256','manifestCanonical','preparationJobId','failureCode','preparedAt'])
        OR (OLD.state NOT IN ('DRAFT','BUILDING') AND
            (NEW.manifest <> OLD.manifest OR NEW."manifestSha256" <> OLD."manifestSha256" OR NEW."manifestCanonical" <> OLD."manifestCanonical" OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt" OR NEW."preparationJobId" IS DISTINCT FROM OLD."preparationJobId"))
        OR NOT (NEW.state = OLD.state OR
            (OLD.state = 'DRAFT' AND NEW.state IN ('BUILDING','SUPERSEDED')) OR
            (OLD.state = 'BUILDING' AND NEW.state IN ('REVIEWABLE','FAILED','SUPERSEDED')) OR
            (OLD.state = 'REVIEWABLE' AND NEW.state IN ('APPROVED','REJECTED','SUPERSEDED','WITHDRAWN')) OR
            (OLD.state = 'APPROVED' AND NEW.state IN ('SUPERSEDED','WITHDRAWN')) OR
            (OLD.state IN ('REJECTED','FAILED','WITHDRAWN') AND NEW.state = 'SUPERSEDED')) THEN
        RAISE EXCEPTION 'Invalid kit revision mutation' USING ERRCODE = '23514';
    END IF;
    IF NEW.state = 'REVIEWABLE' AND (NEW."preparedAt" IS NULL OR NEW."manifestSha256" = '' OR NEW."manifestCanonical" = '') THEN
        RAISE EXCEPTION 'Kit outputs are incomplete' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER kit_revision_immutable BEFORE UPDATE ON platform_release_kit_revision FOR EACH ROW EXECUTE FUNCTION platform_kit_revision_update_guard();

CREATE FUNCTION platform_kit_artifact_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."preparedAt" IS NOT NULL OR NEW."outputKey" IS NULL OR
        (OLD."outputKey" IS NOT NULL AND (NEW."outputKey" <> OLD."outputKey" OR NEW."outputSha256" <> OLD."outputSha256" OR NEW."outputBytes" <> OLD."outputBytes" OR NEW."mediaType" <> OLD."mediaType" OR NEW."rendererVersion" <> OLD."rendererVersion")) OR
        (to_jsonb(NEW) - ARRAY['outputKey','outputSha256','outputBytes','mediaType','rendererVersion','preparedAt'])
        <> (to_jsonb(OLD) - ARRAY['outputKey','outputSha256','outputBytes','mediaType','rendererVersion','preparedAt']) THEN
        RAISE EXCEPTION 'Artifact snapshots and prepared outputs are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER kit_artifact_immutable BEFORE UPDATE ON platform_kit_artifact_revision FOR EACH ROW EXECUTE FUNCTION platform_kit_artifact_update_guard();
CREATE TRIGGER kit_artifact_claim_immutable BEFORE UPDATE ON platform_kit_artifact_claim FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER kit_member_immutable BEFORE UPDATE ON platform_kit_member FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER kit_source_pin_immutable BEFORE UPDATE ON platform_kit_source_pin FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER kit_review_decision_immutable BEFORE UPDATE ON platform_kit_review_decision FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE FUNCTION platform_kit_child_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text;
BEGIN
    SELECT state INTO current_state FROM platform_release_kit_revision
        WHERE "organizationId"=NEW."organizationId" AND "releaseId"=NEW."releaseId" AND id=NEW."kitRevisionId" FOR SHARE;
    IF current_state NOT IN ('DRAFT','BUILDING') THEN
        RAISE EXCEPTION 'Frozen kit membership and source closure are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER kit_member_insert BEFORE INSERT ON platform_kit_member FOR EACH ROW EXECUTE FUNCTION platform_kit_child_insert_guard();
CREATE TRIGGER kit_source_pin_insert BEFORE INSERT ON platform_kit_source_pin FOR EACH ROW EXECUTE FUNCTION platform_kit_child_insert_guard();

CREATE FUNCTION platform_kit_export_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state <> 'BUILDING' OR NEW.state NOT IN ('BUILDING','READY','FAILED') OR
        (OLD."objectKey" IS NOT NULL AND (NEW."objectKey" IS DISTINCT FROM OLD."objectKey" OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.bytes <> OLD.bytes OR NEW."fileIndex" <> OLD."fileIndex")) OR
        (to_jsonb(NEW) - ARRAY['state','objectKey','sha256','bytes','fileIndex','failureCode'])
        <> (to_jsonb(OLD) - ARRAY['state','objectKey','sha256','bytes','fileIndex','failureCode']) THEN
        RAISE EXCEPTION 'Prepared exports are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER kit_export_immutable BEFORE UPDATE ON platform_kit_export FOR EACH ROW EXECUTE FUNCTION platform_kit_export_update_guard();

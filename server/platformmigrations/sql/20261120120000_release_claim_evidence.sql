SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX release_spec_org_release_id ON release_spec ("organizationId", "releaseId", id);

CREATE TABLE platform_evidence_source (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "kind" text NOT NULL CHECK ("kind" IN ('TEXT','ATTESTATION','ASSET','RELEASE_SOURCE')),
    "identitySha256" text NOT NULL,
    "accessClass" text NOT NULL DEFAULT 'PRIVATE_SOURCE' CHECK ("accessClass" IN ('PRIVATE_SOURCE','INTERNAL_MATERIAL','CUSTOMER_CLEARED')),
    "availability" text NOT NULL DEFAULT 'AVAILABLE' CHECK ("availability" IN ('AVAILABLE','UNAVAILABLE','WITHDRAWN')),
    "changeSequence" bigint NOT NULL DEFAULT 1 CHECK ("changeSequence" >= 0),
    "currentVersionId" text,
    "sourceBindingId" text,
    "lastAttemptedAt" timestamptz,
    "lastSuccessAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "kind", "identitySha256")
);
CREATE INDEX evidence_source_lookup_0 ON platform_evidence_source ("organizationId", "sourceBindingId");

CREATE TABLE platform_evidence_version (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "sourceId" text NOT NULL,
    "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 0),
    "format" text NOT NULL CHECK ("format" IN ('TEXT','IMAGE')),
    "origin" text NOT NULL CHECK ("origin" IN ('HUMAN','PROVIDER','AI')),
    "rawSha256" text NOT NULL,
    "normalizedSha256" text NOT NULL,
    "normalizationVersion" text NOT NULL,
    "normalizedText" text,
    "assetId" text,
    "sourceUrl" text,
    "providerRevision" text NOT NULL DEFAULT '',
    "byteLength" bigint NOT NULL DEFAULT 0 CHECK ("byteLength" >= 0),
    "imageWidth" integer NOT NULL DEFAULT 0 CHECK ("imageWidth" >= 0),
    "imageHeight" integer NOT NULL DEFAULT 0 CHECK ("imageHeight" >= 0),
    "redactionAssetId" text,
    "observedAt" timestamptz NOT NULL,
    "authorId" text NOT NULL,
    "confirmedByUserId" text,
    "confirmedAt" timestamptz,
    "attestationScope" text NOT NULL DEFAULT '',
    "limitations" text NOT NULL DEFAULT '',
    "tombstonedAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "sourceId", "id"),
    UNIQUE ("organizationId", "sourceId", "version")
);
CREATE INDEX evidence_version_lookup_0 ON platform_evidence_version ("organizationId", "assetId");

CREATE TABLE platform_release_evidence (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "evidenceVersionId" text NOT NULL,
    "purpose" text NOT NULL,
    "attachedByUserId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId", "evidenceVersionId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX release_evidence_lookup_0 ON platform_release_evidence ("organizationId", "evidenceVersionId");
CREATE TRIGGER release_evidence_immutable BEFORE UPDATE ON platform_release_evidence FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_evidence_clearance (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "evidenceVersionId" text NOT NULL,
    "audienceIds" jsonb NOT NULL,
    "humanUserId" text NOT NULL,
    "sessionId" text NOT NULL,
    "reason" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id")
);
CREATE INDEX evidence_clearance_lookup_0 ON platform_evidence_clearance ("organizationId", "evidenceVersionId", "createdAt");
CREATE TRIGGER evidence_clearance_immutable BEFORE UPDATE ON platform_evidence_clearance FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_release_claim (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "currentVersionId" text,
    "currentSupportSetId" text,
    "currentDecisionId" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX release_claim_lookup_0 ON platform_release_claim ("organizationId", "releaseId", "createdAt", "id");

CREATE TABLE platform_release_claim_version (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "claimId" text NOT NULL,
    "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 0),
    "specId" text,
    "text" text NOT NULL,
    "qualifiers" jsonb NOT NULL,
    "contentSha256" text NOT NULL,
    "origin" text NOT NULL CHECK ("origin" IN ('HUMAN','PROVIDER','AI')),
    "authorId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId", "claimId", "id"),
    UNIQUE ("organizationId", "releaseId", "claimId", "version"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE TRIGGER release_claim_version_immutable BEFORE UPDATE ON platform_release_claim_version FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_claim_support_set (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "claimId" text NOT NULL,
    "claimVersionId" text NOT NULL,
    "version" bigint NOT NULL DEFAULT 1 CHECK ("version" >= 0),
    "supportSha256" text NOT NULL,
    "sourcePins" jsonb NOT NULL,
    "authorId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId", "claimId", "claimVersionId", "id"),
    UNIQUE ("organizationId", "claimVersionId", "version"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE TRIGGER claim_support_set_immutable BEFORE UPDATE ON platform_claim_support_set FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_claim_support (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "claimId" text NOT NULL,
    "claimVersionId" text NOT NULL,
    "supportSetId" text NOT NULL,
    "evidenceVersionId" text NOT NULL,
    "relation" text NOT NULL CHECK ("relation" IN ('SUPPORTS','CONTRADICTS','CONTEXT')),
    "selector" jsonb NOT NULL,
    "selectorSha256" text NOT NULL,
    "exclusionReason" text NOT NULL DEFAULT '',
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "supportSetId", "evidenceVersionId", "relation", "selectorSha256"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX claim_support_lookup_0 ON platform_claim_support ("organizationId", "evidenceVersionId", "claimVersionId");
CREATE TRIGGER claim_support_immutable BEFORE UPDATE ON platform_claim_support FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_claim_verification (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "claimId" text NOT NULL,
    "claimVersionId" text NOT NULL,
    "supportSetId" text NOT NULL,
    "supportSha256" text NOT NULL,
    "claimSha256" text NOT NULL,
    "decision" text NOT NULL CHECK ("decision" IN ('SUPPORTED','CONTRADICTED','UNRESOLVED','WITHDRAWN')),
    "humanUserId" text NOT NULL,
    "sessionId" text NOT NULL,
    "reason" text NOT NULL,
    "supersedesId" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "releaseId", "claimId", "claimVersionId", "id"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX claim_verification_lookup_0 ON platform_claim_verification ("organizationId", "claimVersionId", "createdAt", "id");
CREATE TRIGGER claim_verification_immutable BEFORE UPDATE ON platform_claim_verification FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

CREATE TABLE platform_claim_path_binding (
    "id" text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "specId" text NOT NULL,
    "legacyPath" text NOT NULL,
    "claimId" text NOT NULL,
    "claimVersionId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "id"),
    UNIQUE ("organizationId", "releaseId", "id"),
    UNIQUE ("organizationId", "specId", "legacyPath"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);
CREATE TRIGGER claim_path_binding_immutable BEFORE UPDATE ON platform_claim_path_binding FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

ALTER TABLE platform_evidence_source
    ADD FOREIGN KEY ("organizationId", "sourceBindingId") REFERENCES platform_release_source_binding("organizationId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", id, "currentVersionId") REFERENCES platform_evidence_version("organizationId", "sourceId", id) ON DELETE RESTRICT;
ALTER TABLE platform_evidence_version
    ADD FOREIGN KEY ("organizationId", "sourceId") REFERENCES platform_evidence_source("organizationId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "assetId") REFERENCES asset("organizationId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "redactionAssetId") REFERENCES asset("organizationId", id) ON DELETE RESTRICT,
    ADD CHECK (version > 0 AND "rawSha256" ~ '^[0-9a-f]{64}$' AND "normalizedSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK ("normalizedText" IS NULL OR octet_length("normalizedText") BETWEEN 1 AND 262144),
    ADD CHECK (("confirmedByUserId" IS NULL) = ("confirmedAt" IS NULL)),
    ADD CHECK ("confirmedAt" IS NULL OR origin = 'HUMAN'),
    ADD CHECK ("tombstonedAt" IS NOT NULL OR
        (format = 'TEXT' AND "normalizedText" IS NOT NULL AND "assetId" IS NULL) OR
        (format = 'IMAGE' AND "assetId" IS NOT NULL AND "imageWidth" > 0 AND "imageHeight" > 0));
ALTER TABLE platform_release_evidence
    ADD FOREIGN KEY ("organizationId", "evidenceVersionId") REFERENCES platform_evidence_version("organizationId", id) ON DELETE RESTRICT;
ALTER TABLE platform_evidence_clearance
    ADD FOREIGN KEY ("organizationId", "evidenceVersionId") REFERENCES platform_evidence_version("organizationId", id) ON DELETE RESTRICT,
    ADD CHECK (jsonb_typeof("audienceIds") = 'array' AND jsonb_array_length("audienceIds") BETWEEN 1 AND 20),
    ADD CHECK (octet_length(reason) BETWEEN 1 AND 8192);
ALTER TABLE platform_release_claim_version
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId") REFERENCES platform_release_claim("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "specId") REFERENCES release_spec("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD CHECK (version > 0 AND octet_length(text) BETWEEN 1 AND 4096 AND "contentSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK (jsonb_typeof(qualifiers) = 'object');
ALTER TABLE platform_claim_support_set
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId") REFERENCES platform_release_claim_version("organizationId", "releaseId", "claimId", id) ON DELETE RESTRICT,
    ADD CHECK (version > 0 AND "supportSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK (jsonb_typeof("sourcePins") = 'array' AND jsonb_array_length("sourcePins") <= 20);
ALTER TABLE platform_claim_support
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId", "supportSetId") REFERENCES platform_claim_support_set("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "evidenceVersionId") REFERENCES platform_release_evidence("organizationId", "releaseId", "evidenceVersionId") ON DELETE RESTRICT,
    ADD CHECK (jsonb_typeof(selector) = 'object' AND "selectorSha256" ~ '^[0-9a-f]{64}$'),
    ADD CHECK (octet_length("exclusionReason") <= 8192);
ALTER TABLE platform_claim_verification
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId", "supportSetId") REFERENCES platform_claim_support_set("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId", "supersedesId") REFERENCES platform_claim_verification("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD CHECK ("supportSha256" ~ '^[0-9a-f]{64}$' AND "claimSha256" ~ '^[0-9a-f]{64}$' AND octet_length(reason) BETWEEN 1 AND 8192);
ALTER TABLE platform_claim_path_binding
    ADD FOREIGN KEY ("organizationId", "releaseId", "specId") REFERENCES release_spec("organizationId", "releaseId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", "claimId", "claimVersionId") REFERENCES platform_release_claim_version("organizationId", "releaseId", "claimId", id) ON DELETE RESTRICT;
ALTER TABLE platform_release_claim
    ADD FOREIGN KEY ("organizationId", "releaseId", id, "currentVersionId") REFERENCES platform_release_claim_version("organizationId", "releaseId", "claimId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", id, "currentVersionId", "currentSupportSetId") REFERENCES platform_claim_support_set("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", "releaseId", id, "currentVersionId", "currentDecisionId") REFERENCES platform_claim_verification("organizationId", "releaseId", "claimId", "claimVersionId", id) ON DELETE RESTRICT,
    ADD CHECK ("currentVersionId" IS NOT NULL OR ("currentSupportSetId" IS NULL AND "currentDecisionId" IS NULL));

-- Content is immutable except for irreversible removal. Audit keeps identifiers,
-- never a second copy of the erased passage or confidential URL.
CREATE FUNCTION platform_evidence_version_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."tombstonedAt" IS NULL AND NEW."tombstonedAt" IS NOT NULL
        AND NEW."normalizedText" IS NULL AND NEW."sourceUrl" IS NULL
        AND NEW."assetId" IS NULL AND NEW."redactionAssetId" IS NULL
        AND NEW."attestationScope" = '' AND NEW.limitations = ''
        AND (to_jsonb(NEW) - ARRAY['tombstonedAt','normalizedText','sourceUrl','assetId','redactionAssetId','attestationScope','limitations'])
            = (to_jsonb(OLD) - ARRAY['tombstonedAt','normalizedText','sourceUrl','assetId','redactionAssetId','attestationScope','limitations']) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Evidence versions are immutable except for irreversible erasure' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER evidence_version_immutable BEFORE UPDATE ON platform_evidence_version
    FOR EACH ROW EXECUTE FUNCTION platform_evidence_version_update_guard();

CREATE FUNCTION platform_evidence_source_fence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."organizationId" <> OLD."organizationId" OR NEW.kind <> OLD.kind OR NEW."identitySha256" <> OLD."identitySha256"
        OR NEW."sourceBindingId" IS DISTINCT FROM OLD."sourceBindingId"
        OR NEW."changeSequence" < OLD."changeSequence"
        OR ((NEW."currentVersionId" IS DISTINCT FROM OLD."currentVersionId" OR NEW.availability <> OLD.availability OR NEW."accessClass" <> OLD."accessClass")
            AND NEW."changeSequence" <= OLD."changeSequence") THEN
        RAISE EXCEPTION 'Evidence changes require a new source sequence' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER evidence_source_fenced BEFORE UPDATE ON platform_evidence_source
    FOR EACH ROW EXECUTE FUNCTION platform_evidence_source_fence_guard();


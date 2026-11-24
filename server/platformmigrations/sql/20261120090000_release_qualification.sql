SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

-- Additive and disabled by default. Rollback disables new writes; history stays.
ALTER TABLE workspace_settings ADD COLUMN "releaseReadinessEnabled" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX release_organization_id_id ON release ("organizationId", id);
CREATE UNIQUE INDEX asset_organization_id_id ON asset ("organizationId", id);

CREATE TABLE platform_release_qualification (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    "aggregateRevision" bigint NOT NULL CHECK ("aggregateRevision" > 0),
    "parentRevisionId" text,
    "ownerUserId" text,
    "factReviewerUserId" text,
    rationale text,
    rollout text NOT NULL CHECK (rollout IN ('UNKNOWN', 'PLANNED', 'LIMITED', 'GENERAL', 'WITHDRAWN')),
    availability text,
    exclusions text,
    eligibility text,
    "plannedAvailability" text,
    "readyAt" timestamptz,
    "humanBrief" text,
    "humanBriefAuthorUserId" text,
    "sourceUrls" jsonb NOT NULL CHECK (jsonb_typeof("sourceUrls") = 'array' AND jsonb_array_length("sourceUrls") <= 200),
    "schemaVersion" integer NOT NULL DEFAULT 1 CHECK ("schemaVersion" = 1),
    requirements jsonb NOT NULL CHECK (jsonb_typeof(requirements) = 'array' AND jsonb_array_length(requirements) <= 20),
    "authorKind" text NOT NULL CHECK ("authorKind" IN ('session', 'api_key')),
    "authorId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "releaseId", id),
    UNIQUE ("organizationId", "releaseId", version),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "releaseId", "parentRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT
);

-- User and session IDs are historical attribution, retained through offboarding.
-- Domain commands validate and lock live same-workspace membership before writing.
CREATE TABLE platform_release_qualification_decision (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "qualificationRevisionId" text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('QUALIFIED', 'NO_COMMUNICATION', 'DEFERRED', 'WITHDRAWN')),
    "humanUserId" text NOT NULL,
    "sessionId" text NOT NULL,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 4000),
    "revisitAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "releaseId", id),
    UNIQUE ("organizationId", "releaseId", "qualificationRevisionId"),
    FOREIGN KEY ("organizationId", "releaseId", "qualificationRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT,
    CHECK (decision = 'DEFERRED' OR "revisitAt" IS NULL)
);

CREATE TABLE platform_release_readiness (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "headRevision" bigint NOT NULL DEFAULT 0 CHECK ("headRevision" >= 0),
    "qualificationRevisionId" text,
    "firstQualifiedAt" timestamptz,
    "canonicalState" text NOT NULL DEFAULT 'ACTIVE' CHECK ("canonicalState" IN ('ACTIVE', 'MERGED', 'WITHDRAWN')),
    "mergedIntoReleaseId" text,
    "needsReview" boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "releaseId"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "releaseId", "qualificationRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "mergedIntoReleaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    CHECK (("canonicalState" = 'MERGED') = ("mergedIntoReleaseId" IS NOT NULL)),
    CHECK ("mergedIntoReleaseId" IS NULL OR "mergedIntoReleaseId" <> "releaseId")
);

CREATE TABLE platform_release_qualification_asset (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "qualificationRevisionId" text NOT NULL,
    "assetId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "releaseId", "qualificationRevisionId", "assetId"),
    FOREIGN KEY ("organizationId", "releaseId", "qualificationRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "assetId") REFERENCES asset("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX release_qualification_asset_org_asset ON platform_release_qualification_asset("organizationId", "assetId");

CREATE TABLE platform_readiness_command_receipt (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "actorKind" text NOT NULL CHECK ("actorKind" IN ('session', 'api_key')),
    "actorId" text NOT NULL,
    operation text NOT NULL,
    "commandKey" varchar(128) NOT NULL CHECK (length(btrim("commandKey")) > 0),
    "requestSha256" char(64) NOT NULL CHECK ("requestSha256" ~ '^[0-9a-f]{64}$'),
    "responseRef" jsonb NOT NULL CHECK (jsonb_typeof("responseRef") = 'object'),
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "actorKind", "actorId", operation, "commandKey"),
    FOREIGN KEY ("organizationId", "releaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT
);

CREATE FUNCTION platform_readiness_reject_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Release readiness history is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER qualification_immutable BEFORE UPDATE ON platform_release_qualification
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER qualification_decision_immutable BEFORE UPDATE ON platform_release_qualification_decision
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER qualification_asset_immutable BEFORE UPDATE ON platform_release_qualification_asset
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER readiness_receipt_immutable BEFORE UPDATE ON platform_readiness_command_receipt
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

-- Historical release evidence remains in use after a newer facts version is saved.
CREATE OR REPLACE FUNCTION platform_asset_in_use_v1(org text, asset text, history boolean) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM content_draft d WHERE d."organizationId" = org AND d.status <> 'archived'
     AND (d."assetIds" ? asset OR jsonb_path_exists(jsonb_build_array(d.body, d."platformVersions"),
       '$.** ? (@.assetId == $id || @.coverAssetId == $id || @.thumbnailAssetId == $id)', jsonb_build_object('id', asset))))
 OR EXISTS (
   SELECT 1 FROM scheduled_post p WHERE p."organizationId" = org
     AND (p.status IN ('DRAFT', 'SCHEDULED', 'PROCESSING', 'UNKNOWN_DELIVERY') OR history AND p.status = 'PUBLISHED')
     AND (p."assetId" = asset OR coalesce(p."assetIds", '[]') ? asset
       OR p."publishOptions"->>'documentAssetId' = asset OR p."publishOptions"->>'articleCoverAssetId' = asset
       OR p."publishOptions"->'instagram'->>'coverAssetId' = asset OR p."publishOptions"->'youtube'->>'thumbnailAssetId' = asset
       OR jsonb_path_exists(coalesce(p.replies, '[]'), '$[*].assetIds[*] ? (@ == $id)', jsonb_build_object('id', asset))))
 OR EXISTS (
   SELECT 1 FROM content_batch_item i JOIN content_batch b ON b.id = i."batchId"
   WHERE i."organizationId" = org AND b."archivedAt" IS NULL
     AND (jsonb_path_exists(i.media, '$[*] ? (@.assetId == $id || @.uploadAssetId == $id)', jsonb_build_object('id', asset))
       OR jsonb_path_exists(coalesce(i.grid, '{}'), '$.slots[*] ? (@.assetId == $id)', jsonb_build_object('id', asset))
       OR coalesce(i.grid->>'musicAssetId', '') = asset
       OR coalesce(i.grid->>'closingAssetId', '') = asset))
 OR EXISTS (SELECT 1 FROM platform_release_qualification_asset q WHERE q."organizationId" = org AND q."assetId" = asset)
$$;

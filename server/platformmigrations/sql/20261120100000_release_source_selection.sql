SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX source_app_organization_id_id ON source_app ("organizationId", id);

CREATE TABLE platform_release_source_binding (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "sourceAppId" text NOT NULL,
    provider varchar(64) NOT NULL CHECK (length(provider) > 0),
    "objectKind" text NOT NULL CHECK ("objectKind" IN ('PULL_REQUEST', 'DEPLOYMENT')),
    "repositoryId" varchar(128) NOT NULL,
    "providerObjectId" varchar(200) NOT NULL CHECK (length("providerObjectId") > 0),
    "canonicalReleaseId" text,
    "lastEventSequence" bigint NOT NULL DEFAULT 0 CHECK ("lastEventSequence" >= 0),
    "changeSequence" bigint NOT NULL DEFAULT 0 CHECK ("changeSequence" >= 0),
    "currentObservationId" text,
    "selectedObservationId" text,
    "selectedChangeSequence" bigint NOT NULL DEFAULT 0 CHECK ("selectedChangeSequence" >= 0),
    "needsResolution" boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "sourceAppId", "objectKind", "repositoryId", "providerObjectId"),
    UNIQUE ("organizationId", id),
    UNIQUE ("organizationId", "sourceAppId", id),
    FOREIGN KEY ("organizationId", "sourceAppId") REFERENCES source_app("organizationId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "canonicalReleaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    CHECK ("selectedChangeSequence" <= "changeSequence" AND "changeSequence" <= "lastEventSequence"),
    CHECK ("selectedObservationId" IS NULL OR "canonicalReleaseId" IS NOT NULL)
);
CREATE INDEX release_source_binding_org_release_updated ON platform_release_source_binding("organizationId", "canonicalReleaseId", "updatedAt", id);

CREATE TABLE platform_release_source_observation (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "sourceAppId" text NOT NULL,
    "bindingId" text NOT NULL,
    "eventKey" varchar(512) NOT NULL CHECK (length("eventKey") > 0),
    "providerEventId" varchar(255),
    sequence bigint NOT NULL CHECK (sequence > 0),
    "bodySha256" char(64) NOT NULL CHECK ("bodySha256" ~ '^[0-9a-f]{64}$'),
    "sourceUpdatedAt" timestamptz,
    "occurredAt" timestamptz NOT NULL,
    origin text NOT NULL CHECK (origin IN ('LIVE', 'HISTORICAL')),
    "schemaVersion" integer NOT NULL DEFAULT 1 CHECK ("schemaVersion" = 1),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 131072),
    "receivedAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "sourceAppId", "eventKey"),
    UNIQUE ("organizationId", "bindingId", sequence),
    UNIQUE ("organizationId", "bindingId", id),
    FOREIGN KEY ("organizationId", "sourceAppId", "bindingId") REFERENCES platform_release_source_binding("organizationId", "sourceAppId", id) ON DELETE RESTRICT
);
ALTER TABLE platform_release_source_binding
    ADD FOREIGN KEY ("organizationId", id, "currentObservationId") REFERENCES platform_release_source_observation("organizationId", "bindingId", id) ON DELETE RESTRICT,
    ADD FOREIGN KEY ("organizationId", id, "selectedObservationId") REFERENCES platform_release_source_observation("organizationId", "bindingId", id) ON DELETE RESTRICT;

CREATE TABLE platform_release_qualification_source (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "releaseId" text NOT NULL,
    "qualificationRevisionId" text NOT NULL,
    "bindingId" text NOT NULL,
    "observationId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", "releaseId", "qualificationRevisionId", "bindingId"),
    FOREIGN KEY ("organizationId", "releaseId", "qualificationRevisionId") REFERENCES platform_release_qualification("organizationId", "releaseId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "bindingId", "observationId") REFERENCES platform_release_source_observation("organizationId", "bindingId", id) ON DELETE RESTRICT
);
CREATE INDEX release_qualification_source_org_observation ON platform_release_qualification_source("organizationId", "bindingId", "observationId");
CREATE TRIGGER release_source_observation_immutable BEFORE UPDATE ON platform_release_source_observation
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER release_qualification_source_immutable BEFORE UPDATE ON platform_release_qualification_source
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

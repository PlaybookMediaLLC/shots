SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE platform_release_lineage (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    operation text NOT NULL CHECK (operation IN ('MERGE', 'SPLIT')),
    "sourceReleaseId" text NOT NULL,
    "destinationReleaseId" text NOT NULL,
    "sourceRevision" bigint NOT NULL CHECK ("sourceRevision" > 0),
    "destinationRevision" bigint NOT NULL CHECK ("destinationRevision" > 0),
    reason varchar(4000) NOT NULL CHECK (length(btrim(reason)) > 0),
    "humanUserId" text NOT NULL,
    "sessionId" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE ("organizationId", id),
    FOREIGN KEY ("organizationId", "sourceReleaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "destinationReleaseId") REFERENCES release("organizationId", id) ON DELETE RESTRICT,
    CHECK ("sourceReleaseId" <> "destinationReleaseId")
);
CREATE INDEX release_lineage_org_source_created ON platform_release_lineage("organizationId", "sourceReleaseId", "createdAt", id);
CREATE INDEX release_lineage_org_destination_created ON platform_release_lineage("organizationId", "destinationReleaseId", "createdAt", id);

CREATE TABLE platform_release_lineage_binding (
    id text PRIMARY KEY,
    "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
    "lineageId" text NOT NULL,
    "bindingId" text NOT NULL,
    UNIQUE ("organizationId", "lineageId", "bindingId"),
    FOREIGN KEY ("organizationId", "lineageId") REFERENCES platform_release_lineage("organizationId", id) ON DELETE RESTRICT,
    FOREIGN KEY ("organizationId", "bindingId") REFERENCES platform_release_source_binding("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX release_lineage_binding_org_binding ON platform_release_lineage_binding("organizationId", "bindingId");
CREATE TRIGGER release_lineage_immutable BEFORE UPDATE ON platform_release_lineage
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();
CREATE TRIGGER release_lineage_binding_immutable BEFORE UPDATE ON platform_release_lineage_binding
    FOR EACH ROW EXECUTE FUNCTION platform_readiness_reject_revision_update();

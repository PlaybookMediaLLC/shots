-- Bulk Tools: a durable record of one pass over a batch. A submit run schedules
-- frozen requests in a Temporal workflow, so closing the tab does not stop it. A
-- render run freezes concepts while a browser renders them, so a video can never
-- land on a concept that changed. The posts and assets stay the source of truth.
-- Additive: old code ignores the table, and rollback is DROP TABLE.
CREATE TABLE content_batch_run (
 id text PRIMARY KEY,
 "batchId" text NOT NULL REFERENCES content_batch(id) ON DELETE CASCADE,
 "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('submit', 'render')),
 "requestKey" text NOT NULL CHECK (length("requestKey") BETWEEN 16 AND 128),
 -- What the key first asked for, so reusing it for something else is refused.
 fingerprint text NOT NULL,
 status text NOT NULL CHECK (status IN ('RUNNING', 'FINISHED', 'SUPERSEDED')),
 items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
 -- A submit acts as the person who asked, for as long as they keep their access.
 "createdByUserId" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("batchId", "requestKey")
);
CREATE INDEX content_batch_run_latest ON content_batch_run ("batchId", kind, "createdAt");

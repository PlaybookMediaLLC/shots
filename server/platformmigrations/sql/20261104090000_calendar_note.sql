-- A date-only note on the Plan calendar: not a post, and never published.
-- Additive: older code ignores the table, and it can stay after a rollback.
CREATE TABLE "calendar_note" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 120 AND "title" = btrim("title")),
  "color" text NOT NULL CHECK ("color" IN ('blue', 'green', 'red', 'yellow', 'purple', 'orange')),
  "createdByUserId" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "calendar_note_organizationId_day_idx" ON "calendar_note" ("organizationId", "day");

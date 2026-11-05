-- A capture can record the commit the app reported just before it was taken.
ALTER TABLE "surface_capture" ADD COLUMN "observedRevision" TEXT;

-- A deployment records one capture per page and proof: the receipt a retried or
-- resumed capture run finds instead of capturing that page again. A capture with
-- version proof may follow one taken without it, which could show the old page.
-- A run that crashed before this index may have left duplicates; the current or
-- newest one stays the receipt and the others keep their image without the link.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY "surfaceId", "sourceId"
    ORDER BY ("supersededAt" IS NULL) DESC, "capturedAt" DESC, id DESC) AS position
  FROM "surface_capture"
  WHERE source = 'deployment' AND "sourceId" IS NOT NULL
)
UPDATE "surface_capture" SET "sourceId" = NULL FROM ranked
WHERE "surface_capture".id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX "surface_capture_deployment_receipt_key"
  ON "surface_capture"("surfaceId", "sourceId", COALESCE("observedRevision", ''))
  WHERE source = 'deployment' AND "sourceId" IS NOT NULL;

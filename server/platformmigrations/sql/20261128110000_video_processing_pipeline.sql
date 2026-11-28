-- Phase 4: Server-side video processing snapshot columns, transcode job table,
-- and updated asset retention check preserving all prior clauses from 20261120090000.

ALTER TABLE content_draft
  ADD COLUMN IF NOT EXISTS "processVideosOnServer" boolean;

ALTER TABLE content_batch_item
  ADD COLUMN IF NOT EXISTS "processVideosOnServer" boolean;

CREATE TABLE IF NOT EXISTS video_transcode_job (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "sourceAssetId" text NOT NULL,
  "profileName" text NOT NULL,
  "profileHash" text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  "outputAssetId" text,
  "workflowId" text,
  "errorCode" text,
  "errorMessage" text,
  "startedAt" timestamptz,
  "completedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_transcode_job_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED'))
);

CREATE INDEX IF NOT EXISTS idx_video_transcode_job_org_source
  ON video_transcode_job ("organizationId", "sourceAssetId", "profileHash");

CREATE INDEX IF NOT EXISTS idx_video_transcode_job_status
  ON video_transcode_job (status, "updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_transcode_job_active
  ON video_transcode_job ("organizationId", "sourceAssetId", "profileHash")
  WHERE status IN ('PENDING', 'PROCESSING', 'COMPLETED');

CREATE INDEX IF NOT EXISTS idx_video_transcode_job_active_output
  ON video_transcode_job ("organizationId", "outputAssetId")
  WHERE status IN ('PENDING', 'PROCESSING', 'COMPLETED') AND "outputAssetId" IS NOT NULL;

-- Preserve every prior clause from 20261120090000_release_qualification.sql and
-- add protection for active/cached video_transcode_job source and output assets.
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
 OR EXISTS (
   SELECT 1 FROM video_transcode_job j WHERE j."organizationId" = org
     AND j.status IN ('PENDING', 'PROCESSING') AND j."sourceAssetId" = asset)
 OR EXISTS (
   SELECT 1 FROM video_transcode_job j WHERE j."organizationId" = org
     AND j.status IN ('PENDING', 'PROCESSING', 'COMPLETED') AND j."outputAssetId" = asset)
$$;

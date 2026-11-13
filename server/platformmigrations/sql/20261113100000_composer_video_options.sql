-- Composer options (docs/scheduling/post-bridge/composer/implementation.md):
-- a YouTube video's custom thumbnail is set once the video is live, as a
-- follow-up of its own, so a refused thumbnail never fails the video.
ALTER TABLE post_automation_run DROP CONSTRAINT post_automation_run_kind_check;
ALTER TABLE post_automation_run ADD CONSTRAINT post_automation_run_kind_check
  CHECK ("kind" IN ('first_comment', 'retweet', 'unretweet', 'plug', 'repost_at_likes', 'quote', 'thumbnail'));

-- An Instagram reel's cover and a YouTube thumbnail stay in use while a draft
-- or an unfinished post refers to them. This keeps every reference the
-- function had before it, including a UGC concept's closing clip
-- (20261113090000_content_batch_template_clips.sql).
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
$$;

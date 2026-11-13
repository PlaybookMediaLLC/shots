-- Content Studio: a UGC template video can end with a closing clip. An open
-- batch's concept keeps that clip from being retired, as it does its slot
-- media and music. Only the function changes; the grid column already holds
-- every template kind.
CREATE OR REPLACE FUNCTION platform_asset_in_use_v1(org text, asset text, history boolean) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM content_draft d WHERE d."organizationId" = org AND d.status <> 'archived'
     AND (d."assetIds" ? asset OR jsonb_path_exists(jsonb_build_array(d.body, d."platformVersions"),
       '$.** ? (@.assetId == $id)', jsonb_build_object('id', asset))))
 OR EXISTS (
   SELECT 1 FROM scheduled_post p WHERE p."organizationId" = org
     AND (p.status IN ('DRAFT', 'SCHEDULED', 'PROCESSING', 'UNKNOWN_DELIVERY') OR history AND p.status = 'PUBLISHED')
     AND (p."assetId" = asset OR coalesce(p."assetIds", '[]') ? asset
       OR p."publishOptions"->>'documentAssetId' = asset OR p."publishOptions"->>'articleCoverAssetId' = asset
       OR jsonb_path_exists(coalesce(p.replies, '[]'), '$[*].assetIds[*] ? (@ == $id)', jsonb_build_object('id', asset))))
 OR EXISTS (
   SELECT 1 FROM content_batch_item i JOIN content_batch b ON b.id = i."batchId"
   WHERE i."organizationId" = org AND b."archivedAt" IS NULL
     AND (jsonb_path_exists(i.media, '$[*] ? (@.assetId == $id || @.uploadAssetId == $id)', jsonb_build_object('id', asset))
       OR jsonb_path_exists(coalesce(i.grid, '{}'), '$.slots[*] ? (@.assetId == $id)', jsonb_build_object('id', asset))
       OR coalesce(i.grid->>'musicAssetId', '') = asset
       OR coalesce(i.grid->>'closingAssetId', '') = asset))
$$;

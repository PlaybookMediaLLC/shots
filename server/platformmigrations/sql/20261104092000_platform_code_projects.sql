-- Code Studio projects (docs/code-studio.md) share platform_creative_set's
-- revisions, versions and retention. Additive: existing rows keep their kind.
-- It runs after 20261104090000_platform_store_project.sql, so it keeps 'store'.
-- IF EXISTS: development databases applied this once under an earlier name.
ALTER TABLE "platform_creative_set" DROP CONSTRAINT IF EXISTS "platform_creative_set_kind_check";
ALTER TABLE "platform_creative_set" ADD CONSTRAINT "platform_creative_set_kind_check" CHECK ("kind" IN ('story-set', 'canvas', 'store', 'code'));

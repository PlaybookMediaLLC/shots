-- Code Studio projects (docs/code-studio.md) share platform_creative_set's
-- revisions, versions and retention. Additive: existing rows keep their kind.
-- IF EXISTS: development databases applied this once under an earlier name.
ALTER TABLE "platform_creative_set" DROP CONSTRAINT IF EXISTS "platform_creative_set_kind_check";
ALTER TABLE "platform_creative_set" ADD CONSTRAINT "platform_creative_set_kind_check" CHECK ("kind" IN ('story-set', 'canvas', 'code'));

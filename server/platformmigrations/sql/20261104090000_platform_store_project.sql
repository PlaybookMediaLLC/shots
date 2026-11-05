-- Store screenshot projects saved to the workspace share platform_creative_set's
-- revisions, versions and retention. Additive: existing rows keep their kind.
ALTER TABLE "platform_creative_set" DROP CONSTRAINT "platform_creative_set_kind_check";
ALTER TABLE "platform_creative_set" ADD CONSTRAINT "platform_creative_set_kind_check" CHECK ("kind" IN ('story-set', 'canvas', 'store'));

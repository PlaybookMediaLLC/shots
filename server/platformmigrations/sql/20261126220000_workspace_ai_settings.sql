-- Workspace AI model defaults (per-surface tier & effort), standing custom instructions,
-- and encrypted-at-rest BYOK OpenRouter API key metadata for Balanced/Deep tiers.
ALTER TABLE "workspace_settings"
  ADD COLUMN IF NOT EXISTS "aiModelDefaults" JSONB,
  ADD COLUMN IF NOT EXISTS "aiInstructions" TEXT,
  ADD COLUMN IF NOT EXISTS "aiProviderKeyEncrypted" TEXT,
  ADD COLUMN IF NOT EXISTS "aiProviderKeyHint" TEXT;

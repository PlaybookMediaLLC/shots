-- An enterprise organization's app branding (internal/whitelabel): name, logo,
-- favicon and colors shown in place of Shots' own. NULL keeps the defaults.
ALTER TABLE "organization_enterprise_settings" ADD COLUMN "whitelabelSettings" JSONB;

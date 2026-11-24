SET LOCAL lock_timeout = '5s';
-- Persist the marker's focus bounding box (0-1 viewport fractions) on each capture attempt
-- so downstream campaign renders can frame or highlight the changed feature.
ALTER TABLE capture ADD COLUMN "focusBox" JSONB;
-- Persist safe navigation links observed during sign-in for guided surface discovery,
-- plus optional customer-hosted session bootstrap endpoint and encrypted signing secret.
ALTER TABLE platform_app_connection ADD COLUMN "discoveredRoutes" JSONB;
ALTER TABLE platform_app_connection ADD COLUMN "bootstrapUrl" TEXT;
ALTER TABLE platform_app_connection ADD COLUMN "bootstrapSecretCiphertext" TEXT;

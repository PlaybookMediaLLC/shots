-- A share link can embed a frozen Code Studio document (RFC 053) as text.
ALTER TABLE "share_link" ADD COLUMN "code" JSONB;

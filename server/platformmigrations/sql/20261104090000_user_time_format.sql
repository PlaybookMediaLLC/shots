-- The clock a person reads times on (RFC 024 preferences): auto follows the
-- browser locale, as every account did before this column.
ALTER TABLE "user_preference"
  ADD COLUMN "timeFormat" TEXT NOT NULL DEFAULT 'auto' CHECK ("timeFormat" IN ('auto', '12h', '24h'));

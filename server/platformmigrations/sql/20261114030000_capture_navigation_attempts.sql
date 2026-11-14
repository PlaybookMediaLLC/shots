SET LOCAL lock_timeout = '5s';
ALTER TABLE capture_job ADD COLUMN "navigationAttempts" integer NOT NULL DEFAULT 0;

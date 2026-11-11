-- Deployed databases run the API and worker as shots_runtime. Its default
-- privileges cover tables and sequences, not functions revoked from PUBLIC.
-- Without this grant, account deletion returns 500 and its maintenance job fails.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shots_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.platform_account_attachment_blockers(text) TO shots_runtime;
  END IF;
END $$;

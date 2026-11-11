ALTER TABLE founder_hub.github_star_leads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'github_star_leads' AND policyname = 'github_star_leads_service_all'
  ) THEN
    CREATE POLICY "github_star_leads_service_all" ON founder_hub.github_star_leads AS PERMISSIVE FOR ALL TO "shots_hub_service_role" USING (true) WITH CHECK (true);
  END IF;
END
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'checkpoint_migrations',
    'checkpoints',
    'checkpoint_blobs',
    'checkpoint_writes'
  ]
  LOOP
    IF to_regclass(format('founder_hub.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE founder_hub.%I ENABLE ROW LEVEL SECURITY', table_name);
      EXECUTE format('REVOKE ALL ON TABLE founder_hub.%I FROM shots_hub_anon, shots_hub_authenticated', table_name);
      EXECUTE format('GRANT ALL ON TABLE founder_hub.%I TO shots_hub_service_role', table_name);
      EXECUTE format('DROP POLICY IF EXISTS checkpoint_internal_only ON founder_hub.%I', table_name);
      EXECUTE format(
        'CREATE POLICY checkpoint_internal_only ON founder_hub.%I AS RESTRICTIVE FOR ALL TO shots_hub_anon, shots_hub_authenticated USING (false) WITH CHECK (false)',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF to_regclass('founder_hub.media_assets') IS NOT NULL THEN
    ALTER TABLE founder_hub.media_assets ENABLE ROW LEVEL SECURITY;

    REVOKE ALL ON TABLE founder_hub.media_assets FROM shots_hub_anon, shots_hub_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE founder_hub.media_assets TO shots_hub_authenticated;
    GRANT ALL ON TABLE founder_hub.media_assets TO shots_hub_service_role;

    DROP POLICY IF EXISTS media_assets_admin_all ON founder_hub.media_assets;
    -- This mirrors the server-side admin allowlist so existing admin media routes keep working under RLS.
    CREATE POLICY media_assets_admin_all
      ON founder_hub.media_assets
      AS PERMISSIVE
      FOR ALL
      TO shots_hub_authenticated
      USING (
        (SELECT lower(founder_hub_identity.jwt() ->> 'email')) = ANY (ARRAY[
          'yujonglee@hyprnote.com',
          'yujonglee.dev@gmail.com',
          'john@hyprnote.com',
          'marketing@hyprnote.com',
          'yunhyungjo@yonsei.ac.kr',
          'goranmoomin@daum.net',
          'artem@hyprnote.com',
          'stua@fastmail.com',
          'thestua@gmail.com'
        ])
      )
      WITH CHECK (
        (SELECT lower(founder_hub_identity.jwt() ->> 'email')) = ANY (ARRAY[
          'yujonglee@hyprnote.com',
          'yujonglee.dev@gmail.com',
          'john@hyprnote.com',
          'marketing@hyprnote.com',
          'yunhyungjo@yonsei.ac.kr',
          'goranmoomin@daum.net',
          'artem@hyprnote.com',
          'stua@fastmail.com',
          'thestua@gmail.com'
        ])
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regprocedure('founder_hub.set_updated_at()') IS NOT NULL THEN
    ALTER FUNCTION founder_hub.set_updated_at() SET search_path = '';
  END IF;

  IF to_regprocedure('founder_hub.handle_new_user()') IS NOT NULL THEN
    ALTER FUNCTION founder_hub.handle_new_user() SET search_path = '';
    REVOKE EXECUTE ON FUNCTION founder_hub.handle_new_user() FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
    GRANT EXECUTE ON FUNCTION founder_hub.handle_new_user() TO shots_hub_supabase_auth_admin;
  END IF;

  IF to_regprocedure('founder_hub.handle_user_email_update()') IS NOT NULL THEN
    ALTER FUNCTION founder_hub.handle_user_email_update() SET search_path = '';
    REVOKE EXECUTE ON FUNCTION founder_hub.handle_user_email_update() FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
    GRANT EXECUTE ON FUNCTION founder_hub.handle_user_email_update() TO shots_hub_supabase_auth_admin;
  END IF;

  IF to_regprocedure('founder_hub.custom_access_token_hook(jsonb)') IS NOT NULL THEN
    ALTER FUNCTION founder_hub.custom_access_token_hook(jsonb) SET search_path = '';
  END IF;
END;
$$;

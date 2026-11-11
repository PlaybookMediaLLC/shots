DO $$
BEGIN
  IF to_regclass('founder_hub.media_assets') IS NOT NULL THEN
    DROP POLICY IF EXISTS media_assets_admin_all ON founder_hub.media_assets;

    CREATE POLICY media_assets_admin_all
      ON founder_hub.media_assets
      AS PERMISSIVE
      FOR ALL
      TO shots_hub_authenticated
      USING (
        (SELECT lower(founder_hub_identity.jwt() ->> 'email')) = ANY (ARRAY[
          'john@fastrepl.com',
          'artem@fastrepl.com'
        ])
      )
      WITH CHECK (
        (SELECT lower(founder_hub_identity.jwt() ->> 'email')) = ANY (ARRAY[
          'john@fastrepl.com',
          'artem@fastrepl.com'
        ])
      );
  END IF;
END;
$$;

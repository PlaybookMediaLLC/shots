DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['shots_hub_owner','shots_hub_anon','shots_hub_authenticated','shots_hub_service_role','shots_hub_supabase_auth_admin','shots_hub_authenticator','shots_hub_storage'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT',role_name);
    END IF;
  END LOOP;
END $$;

ALTER ROLE shots_hub_authenticator LOGIN;
ALTER ROLE shots_hub_storage LOGIN;
ALTER ROLE shots_hub_service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS founder_hub AUTHORIZATION shots_hub_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_private AUTHORIZATION shots_hub_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_identity AUTHORIZATION shots_hub_owner;
CREATE SCHEMA IF NOT EXISTS founder_hub_billing AUTHORIZATION shots_hub_owner;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION shots_hub_owner;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT shots_hub_anon, shots_hub_authenticated, shots_hub_service_role TO shots_hub_authenticator;
GRANT shots_hub_owner, shots_hub_anon, shots_hub_authenticated, shots_hub_service_role TO shots_hub_storage;
ALTER ROLE shots_hub_storage SET role = shots_hub_owner;
GRANT USAGE ON SCHEMA public, extensions TO shots_hub_owner;
GRANT REFERENCES ("accountUserId") ON public.platform_founder_hub_user TO shots_hub_owner;
GRANT EXECUTE ON FUNCTION public.platform_founder_hub_account_available(uuid) TO shots_hub_owner;
GRANT USAGE ON SCHEMA founder_hub, founder_hub_identity, extensions, storage TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;
GRANT USAGE ON SCHEMA founder_hub_private TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;

SET LOCAL ROLE shots_hub_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT ALL ON TABLES TO shots_hub_service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT ALL ON SEQUENCES TO shots_hub_service_role;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_hub GRANT EXECUTE ON FUNCTIONS TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT USAGE, SELECT ON SEQUENCES TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA storage GRANT EXECUTE ON FUNCTIONS TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;

CREATE TABLE IF NOT EXISTS founder_hub_private.schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());

-- Identity projections have no passwords, sessions, or independent sign-in authority.
CREATE TABLE IF NOT EXISTS founder_hub_identity.users (
  id uuid PRIMARY KEY REFERENCES public.platform_founder_hub_user("accountUserId") ON DELETE CASCADE,
  aud text,
  role text,
  email text,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (least(email_confirmed_at,phone_confirmed_at)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false,
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}',
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'
);
CREATE OR REPLACE FUNCTION founder_hub_identity.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb, '{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION founder_hub_identity.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(founder_hub_identity.jwt()->>'sub','')::uuid
$$;
REVOKE ALL ON ALL TABLES IN SCHEMA founder_hub_identity FROM PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA founder_hub_identity TO shots_hub_service_role;
GRANT EXECUTE ON FUNCTION founder_hub_identity.uid(), founder_hub_identity.jwt() TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;

-- Minimal Supabase Storage schema for migration-only PostgreSQL tests.
-- Production provides these objects through its Storage service.
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
ALTER TABLE storage.buckets OWNER TO shots_hub_owner;

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL REFERENCES storage.buckets(id),
  name text NOT NULL,
  owner text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects OWNER TO shots_hub_owner;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION storage.foldername(p_name text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT (string_to_array(trim(both '/' from p_name), '/'))[
    1:cardinality(string_to_array(trim(both '/' from p_name), '/')) - 1
  ]
$$;

DO $$
BEGIN
  IF storage.foldername('owner/audio/file.m4a') IS DISTINCT FROM ARRAY['owner', 'audio']::text[]
    OR storage.foldername('file.m4a') IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION 'storage.foldername test fixture is incorrect';
  END IF;
END;
$$;

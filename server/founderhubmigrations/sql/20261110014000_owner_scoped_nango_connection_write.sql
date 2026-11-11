CREATE FUNCTION founder_hub.upsert_nango_connection(
  p_user_id uuid,
  p_integration_id text,
  p_connection_id text,
  p_provider text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF founder_hub_identity.uid() IS NULL OR founder_hub_identity.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Not authorized to write this Nango connection' USING ERRCODE = '42501';
  END IF;
  IF p_integration_id NOT IN ('hubspot', 'attio', 'salesforce', 'pipedrive', 'close')
    OR p_connection_id IS NULL OR length(p_connection_id) NOT BETWEEN 1 AND 200
    OR p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid Nango connection' USING ERRCODE = '22023';
  END IF;
  INSERT INTO founder_hub.nango_connections(user_id, integration_id, connection_id, provider, status)
    VALUES (p_user_id, p_integration_id, p_connection_id, p_provider, 'connected')
  ON CONFLICT (integration_id, connection_id) DO UPDATE SET
    provider = EXCLUDED.provider,
    status = 'connected',
    last_error_type = NULL,
    last_error_description = NULL,
    last_error_at = NULL,
    updated_at = now()
  WHERE founder_hub.nango_connections.user_id = EXCLUDED.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Nango connection already belongs to another account' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION founder_hub.delete_nango_connection(
  p_integration_id text,
  p_connection_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF founder_hub_identity.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized to delete Nango connection' USING ERRCODE = '42501';
  END IF;
  DELETE FROM founder_hub.nango_connections
    WHERE user_id = founder_hub_identity.uid()
      AND integration_id = p_integration_id
      AND connection_id = p_connection_id;
END;
$$;

REVOKE ALL ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  FROM PUBLIC, shots_hub_anon;
GRANT EXECUTE ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  TO shots_hub_authenticated;
REVOKE ALL ON FUNCTION founder_hub.delete_nango_connection(text, text)
  FROM PUBLIC, shots_hub_anon;
GRANT EXECUTE ON FUNCTION founder_hub.delete_nango_connection(text, text)
  TO shots_hub_authenticated;

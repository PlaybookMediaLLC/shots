REVOKE ALL ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub.upsert_nango_connection(uuid, text, text, text)
  TO shots_hub_service_role;
REVOKE ALL ON FUNCTION founder_hub.delete_nango_connection(text, text)
  FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub.delete_nango_connection(text, text)
  TO shots_hub_service_role;

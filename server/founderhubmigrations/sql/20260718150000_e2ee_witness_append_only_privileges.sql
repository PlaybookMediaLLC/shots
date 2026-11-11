REVOKE ALL ON TABLE founder_hub.e2ee_freshness_events FROM shots_hub_service_role;
GRANT SELECT, INSERT ON TABLE founder_hub.e2ee_freshness_events TO shots_hub_service_role;

REVOKE ALL ON SEQUENCE founder_hub.e2ee_freshness_events_sequence_seq
  FROM shots_hub_service_role;
GRANT USAGE, SELECT ON SEQUENCE founder_hub.e2ee_freshness_events_sequence_seq
  TO shots_hub_service_role;

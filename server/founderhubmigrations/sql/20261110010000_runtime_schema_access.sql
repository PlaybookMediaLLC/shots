-- PostgREST runs its pre-request guard as the caller; the schema remains unexposed and function ACLs still apply.
GRANT USAGE ON SCHEMA founder_hub_private TO shots_hub_anon, shots_hub_authenticated, shots_hub_service_role;

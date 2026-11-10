CREATE OR REPLACE FUNCTION founder_hub.project_shots_authority(p_snapshot jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_revision bigint := (p_snapshot->>'revision')::bigint;
  v_actor uuid := (p_snapshot->>'accountUserId')::uuid;
  v_workspace jsonb;
  v_member jsonb;
  v_workspace_id uuid;
  v_member_id uuid;
  v_permissions text[];
  v_members uuid[];
  v_active_members uuid[];
  v_workspaces uuid[] := ARRAY[]::uuid[];
  v_previous founder_hub_private.shots_workspaces;
BEGIN
  IF v_revision IS NULL OR v_revision < 0 OR v_actor IS NULL OR jsonb_typeof(p_snapshot->'workspaces') <> 'array'
    OR (p_snapshot->>'expiresAt')::timestamptz <= now() THEN
    RAISE EXCEPTION 'Invalid Shots snapshot' USING ERRCODE = '22023';
  END IF;
  -- Roster updates overlap across actors; serialize this short projection transaction.
  PERFORM pg_advisory_xact_lock(716268349103);
  PERFORM founder_hub_private.project_shots_user(p_snapshot, v_revision);
  FOR v_workspace IN SELECT value FROM jsonb_array_elements(p_snapshot->'workspaces') LOOP
    v_workspace_id := (v_workspace->>'workspaceId')::uuid;
    IF v_workspace_id = v_actor OR v_workspace_id = ANY(v_workspaces) THEN
      RAISE EXCEPTION 'Invalid Shots workspace identity' USING ERRCODE = '22023';
    END IF;
    v_workspaces := array_append(v_workspaces, v_workspace_id);
    SELECT * INTO v_previous FROM founder_hub_private.shots_workspaces WHERE workspace_id = v_workspace_id;
    IF v_previous.workspace_id IS NOT NULL THEN
      IF v_previous.shots_organization_id <> v_workspace->>'organizationId' THEN
        RAISE EXCEPTION 'Shots workspace mismatch' USING ERRCODE = '42501';
      END IF;
      IF v_previous.revision > v_revision THEN RAISE EXCEPTION 'Stale Shots authority' USING ERRCODE = '40001'; END IF;
    ELSIF EXISTS (SELECT 1 FROM founder_hub.workspaces WHERE id = v_workspace_id) THEN
      RAISE EXCEPTION 'Existing workspace requires an explicit Shots identity migration' USING ERRCODE = '42501';
    END IF;
    PERFORM founder_hub_private.project_shots_user(v_workspace->'owner', v_revision);
    IF (v_workspace->>'ownerUserId')::uuid <> (v_workspace->'owner'->>'accountUserId')::uuid THEN
      RAISE EXCEPTION 'Invalid Shots workspace owner' USING ERRCODE = '22023';
    END IF;
    INSERT INTO founder_hub.workspaces (id, owner_user_id, kind, name)
    VALUES (v_workspace_id, (v_workspace->>'ownerUserId')::uuid, 'shared', v_workspace->>'name')
    ON CONFLICT (id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
      name = EXCLUDED.name, deleted_at = NULL, updated_at = now()
    WHERE founder_hub.workspaces.owner_user_id IS DISTINCT FROM EXCLUDED.owner_user_id
      OR founder_hub.workspaces.name IS DISTINCT FROM EXCLUDED.name OR founder_hub.workspaces.deleted_at IS NOT NULL;
    INSERT INTO founder_hub_private.shots_workspaces (workspace_id, shots_organization_id, features, revision)
    VALUES (v_workspace_id, v_workspace->>'organizationId', v_workspace->'features', v_revision)
    ON CONFLICT (workspace_id) DO UPDATE SET features = EXCLUDED.features, revision = EXCLUDED.revision
    WHERE founder_hub_private.shots_workspaces.features IS DISTINCT FROM EXCLUDED.features OR founder_hub_private.shots_workspaces.revision IS DISTINCT FROM EXCLUDED.revision;
    v_members := ARRAY[]::uuid[];
    v_active_members := ARRAY[]::uuid[];
    FOR v_member IN SELECT value FROM jsonb_array_elements(v_workspace->'members') LOOP
      -- A pre-deletion snapshot may still contain a departing teammate.
      CONTINUE WHEN NOT public.platform_founder_hub_account_available((v_member->>'accountUserId')::uuid);
      PERFORM founder_hub_private.project_shots_user(v_member, v_revision);
      v_member_id := (v_member->>'accountUserId')::uuid;
      SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO v_permissions FROM jsonb_array_elements_text(v_member->'permissions');
      IF v_member_id = ANY(v_members) THEN RAISE EXCEPTION 'Duplicate Shots member' USING ERRCODE = '22023'; END IF;
      v_members := array_append(v_members, v_member_id);
      INSERT INTO founder_hub_private.shots_memberships (workspace_id, user_id, permissions)
      VALUES (v_workspace_id, v_member_id, v_permissions)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions
      WHERE founder_hub_private.shots_memberships.permissions IS DISTINCT FROM EXCLUDED.permissions;
      IF NOT 'workspace:read' = ANY(v_permissions) THEN CONTINUE; END IF;
      v_active_members := array_append(v_active_members, v_member_id);
      INSERT INTO founder_hub.workspace_memberships (workspace_id, user_id, role)
      VALUES (v_workspace_id, v_member_id, CASE WHEN v_member->>'role' IN ('owner', 'admin') THEN v_member->>'role' ELSE 'member' END)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role, deleted_at = NULL, updated_at = now()
      WHERE founder_hub.workspace_memberships.role IS DISTINCT FROM EXCLUDED.role OR founder_hub.workspace_memberships.deleted_at IS NOT NULL;
    END LOOP;
    IF NOT v_actor = ANY(v_members) THEN RAISE EXCEPTION 'Actor missing from Shots roster' USING ERRCODE = '42501'; END IF;
    UPDATE founder_hub.workspace_memberships SET deleted_at = now(), updated_at = now()
    WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_active_members) AND deleted_at IS NULL;
    DELETE FROM founder_hub_private.shots_memberships WHERE workspace_id = v_workspace_id AND NOT user_id = ANY(v_members);
  END LOOP;
  UPDATE founder_hub.workspace_memberships SET deleted_at = now(), updated_at = now()
  WHERE user_id = v_actor AND workspace_id IN (SELECT workspace_id FROM founder_hub_private.shots_workspaces)
    AND NOT workspace_id = ANY(v_workspaces) AND deleted_at IS NULL;
  DELETE FROM founder_hub_private.shots_memberships WHERE user_id = v_actor AND NOT workspace_id = ANY(v_workspaces);
END;
$$;
REVOKE ALL ON FUNCTION founder_hub.project_shots_authority(jsonb) FROM PUBLIC, shots_hub_anon, shots_hub_authenticated;
GRANT EXECUTE ON FUNCTION founder_hub.project_shots_authority(jsonb) TO shots_hub_service_role;

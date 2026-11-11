CREATE FUNCTION platform_account_attachment_blockers(p_user_id text)
RETURNS TABLE(workspace_id text, workspace_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF to_regclass('founder_hub.session_share_attachment_objects') IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT DISTINCT org.id, org.name
  FROM public.platform_founder_hub_user identity
  JOIN founder_hub.session_share_attachment_objects attachment ON attachment.owner_user_id=identity."accountUserId"
  JOIN founder_hub.session_shares share ON share.id=attachment.share_id
  JOIN founder_hub_private.shots_workspaces mapped ON mapped.workspace_id=share.workspace_id
  JOIN public.organization org ON org.id=mapped.shots_organization_id
  JOIN public.member owner ON owner."organizationId"=org.id AND owner.role LIKE '%owner%'
  WHERE identity."userId"=p_user_id AND owner."userId"<>p_user_id AND attachment.state<>'deleting';
END;
$$;
REVOKE ALL ON FUNCTION platform_account_attachment_blockers(text) FROM PUBLIC;

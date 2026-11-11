import { z } from 'zod'

const resourceType = z.enum(['folder', 'template', 'automation'])
/** The original private, team and named-guest library contract. */
export const founderHubSharedResourceSchema = z.object({
  share_id: z.uuid(),
  resource_type: resourceType,
  source_id: z.string(),
  resource_title: z.string(),
  payload: z.record(z.string(), z.unknown()),
  owner_user_id: z.uuid(),
  owner_email: z.string(),
  general_workspace_id: z.uuid().nullable(),
  workspace_name: z.string().nullable(),
  access_kind: z.enum(['owner', 'team', 'guest']),
  updated_at: z.string(),
})
/** Named guest access can be removed independently of the library's workspace visibility. */
export const founderHubResourceGuestSchema = z.object({
  guest_id: z.uuid(),
  invitee_email: z.string(),
  created_at: z.string().optional(),
})
/** Only domain operations are accepted; callers cannot choose SQL or a function name. */
export const founderHubResourceActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), resourceType }).strict(),
  z
    .object({
      action: z.literal('publish'),
      resourceType,
      sourceId: z.string().min(1).max(256),
      title: z.string().min(1).max(512),
      payload: z.record(z.string(), z.unknown()),
      workspaceId: z.uuid().nullable(),
    })
    .strict(),
  z.object({ action: z.literal('guests'), shareId: z.uuid() }).strict(),
  z.object({ action: z.literal('invite'), shareId: z.uuid(), email: z.email().max(320) }).strict(),
  z.object({ action: z.literal('revoke'), guestId: z.uuid() }).strict(),
  z.object({ action: z.literal('delete'), shareId: z.uuid() }).strict(),
])
/** Runtime responses are narrowed again to the operation's expected shape by each caller. */
export const founderHubResourceResultSchema = z.array(z.record(z.string(), z.unknown()))
/** Current Shots memberships supply the shared-library destination picker. */
export const founderHubShareWorkspaceSchema = z.object({ id: z.uuid(), name: z.string() })

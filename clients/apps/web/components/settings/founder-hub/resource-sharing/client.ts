import { z } from 'zod'
import {
  founderHubSharedResourceSchema,
  founderHubResourceGuestSchema,
  founderHubResourceActionSchema,
  founderHubResourceResultSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest } from '@/lib/settings/client'

const resourceSchema = founderHubSharedResourceSchema.transform((row) => ({
  shareId: row.share_id,
  resourceType: row.resource_type,
  sourceId: row.source_id,
  title: row.resource_title,
  payload: row.payload,
  ownerUserId: row.owner_user_id,
  ownerEmail: row.owner_email,
  generalWorkspaceId: row.general_workspace_id,
  workspaceName: row.workspace_name,
  accessKind: row.access_kind,
  updatedAt: row.updated_at,
}))
const guestSchema = founderHubResourceGuestSchema.transform((row) => ({
  guestId: row.guest_id,
  email: row.invitee_email,
  createdAt: row.created_at ?? '',
}))
export type SharedResource = z.infer<typeof resourceSchema>
export type SharedResourceGuest = z.infer<typeof guestSchema>
export type SharedResourceType = SharedResource['resourceType']

async function request(body: z.input<typeof founderHubResourceActionSchema>) {
  return settingsRequest('/api/founder-hub/resources', founderHubResourceResultSchema, {
    method: 'POST',
    body: founderHubResourceActionSchema.parse(body),
  })
}
export async function listSharedResources(resourceType: SharedResourceType) {
  return z.array(resourceSchema).parse(await request({ action: 'list', resourceType }))
}
export async function upsertSharedResource(input: {
  resourceType: SharedResourceType
  sourceId: string
  title: string
  payload: Record<string, unknown>
  generalWorkspaceId: string | null
}) {
  const [row] = z
    .array(z.object({ share_id: z.uuid(), general_workspace_id: z.uuid().nullable() }))
    .min(1)
    .parse(
      await request({
        action: 'publish',
        resourceType: input.resourceType,
        sourceId: input.sourceId,
        title: input.title,
        payload: input.payload,
        workspaceId: input.generalWorkspaceId,
      })
    )
  return { shareId: row.share_id, generalWorkspaceId: row.general_workspace_id }
}
export async function listSharedResourceGuests(shareId: string) {
  return z.array(guestSchema).parse(await request({ action: 'guests', shareId }))
}
export async function grantSharedResourceAccess(shareId: string, email: string) {
  const [guest] = z
    .array(guestSchema)
    .min(1)
    .parse(await request({ action: 'invite', shareId, email: email.trim().toLowerCase() }))
  return guest
}
export async function revokeSharedResourceAccess(guestId: string) {
  await request({ action: 'revoke', guestId })
}
export async function deleteSharedResource(shareId: string) {
  await request({ action: 'delete', shareId })
}
export function isTeamSharingUpsellError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes('multi-resource guest requires Team membership') ||
      error.message.includes('workspace capability required'))
  )
}

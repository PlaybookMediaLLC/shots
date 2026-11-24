import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { ReleaseQualification } from './ReleaseQualification'

/** Stream qualification separately so an optional facts review does not block release context. */
export async function ReleaseQualificationSection({
  tenant,
  releaseId,
  userId,
  canEdit,
  canDecide,
  canReadMembers,
  inactive,
  sourceUrls,
}: {
  tenant: TenantContext
  releaseId: string
  userId: string
  canEdit: boolean
  canDecide: boolean
  canReadMembers: boolean
  inactive: boolean
  sourceUrls: string[]
}) {
  const sdk = backendSDK(tenant)
  const initial = await sdk.getReleaseQualification(releaseId).catch(() => null)
  if (initial && !initial.enabled && !initial.current) {
    const history = await sdk.getReleaseLineage(releaseId).catch(() => null)
    if (initial.canonicalState === 'ACTIVE' && history?.items.length === 0) return null
  }
  const members = canReadMembers ? await sdk.listWorkspaceMembers().catch(() => null) : null
  return (
    <ReleaseQualification
      key={`${tenant.organizationId}:${releaseId}`}
      initial={initial}
      releaseId={releaseId}
      workspaceId={tenant.organizationId}
      userId={userId}
      canEdit={canEdit}
      canDecide={canDecide}
      inactive={inactive}
      sourceUrls={sourceUrls}
      membersUnavailable={canReadMembers && members === null}
      members={
        members?.members.map((member) => ({
          userId: member.userId,
          name: member.user.name || member.user.email,
          role: member.role,
        })) ?? []
      }
    />
  )
}

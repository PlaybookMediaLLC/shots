import 'server-only'

import type { OrganizationAccess, SessionAccess } from '@/lib/auth/access'
import { backendSDK, serviceBackend } from '@/lib/backend/sdk'
import type {
  WorkspaceDeletion as BackendWorkspaceDeletion,
  WorkspaceInvitationDetail as BackendWorkspaceInvitationDetail,
  WorkspaceSettings as BackendWorkspaceSettings,
} from 'screenshot-studio-backend-sdk'
import { normalizeOrganizationRole } from '@/lib/auth/permissions'
import { parseWorkspaceAiDefaults } from '@/lib/ai/models/tiers'
import { brandKitLibrary, storedBrandKitSchema } from '@/lib/brand/kit'
import { listCampaigns } from '@/lib/tenant/campaigns'
import { getBrandProfile, listBrandKits } from '@/lib/tenant/configuration'
import { getProductProfile } from '@/lib/tenant/product-profile'
import { listProductSurfaces } from '@/lib/tenant/product-surfaces'
import type {
  WorkspaceAiSettingsUpdateInput,
  WorkspaceCreateInput,
  WorkspaceInviteInput,
  WorkspaceUpdateInput,
} from './schemas'

function fromBackendSettings(settings: BackendWorkspaceSettings) {
  return {
    ...settings,
    createdAt: new Date(settings.createdAt),
    updatedAt: new Date(settings.updatedAt),
  }
}

function fromBackendDeletion(deletion: BackendWorkspaceDeletion) {
  return {
    ...deletion,
    scheduledFor: new Date(deletion.scheduledFor),
    cancelledAt: deletion.cancelledAt ? new Date(deletion.cancelledAt) : null,
    processingAt: deletion.processingAt ? new Date(deletion.processingAt) : null,
    purgedAt: deletion.purgedAt ? new Date(deletion.purgedAt) : null,
    createdAt: new Date(deletion.createdAt),
    updatedAt: new Date(deletion.updatedAt),
  }
}

function fromBackendInvitationDetail(invitation: BackendWorkspaceInvitationDetail) {
  return {
    ...invitation,
    createdAt: new Date(invitation.createdAt),
    expiresAt: new Date(invitation.expiresAt),
    role: invitation.role ? normalizeOrganizationRole(invitation.role) : null,
  }
}

export async function createWorkspace(access: SessionAccess, input: WorkspaceCreateInput) {
  const result = await backendSDK({ ...access, organizationId: '' }).createWorkspace(input)
  return { organization: result.organization, settings: fromBackendSettings(result.settings) }
}

export async function listWorkspaces(access: SessionAccess) {
  const result = await backendSDK({ ...access, organizationId: '' }).listWorkspaces()
  return result.workspaces
}

export async function setActiveWorkspace(access: SessionAccess, organizationId: string) {
  await backendSDK({ ...access, organizationId: '' }).setActiveWorkspace(organizationId)
}

export async function getWorkspace(access: OrganizationAccess) {
  const { workspace } = await backendSDK(access).getWorkspace()
  return (
    workspace && {
      ...workspace,
      workspaceSettings: workspace.workspaceSettings
        ? fromBackendSettings(workspace.workspaceSettings)
        : null,
    }
  )
}

export async function updateWorkspace(access: OrganizationAccess, input: WorkspaceUpdateInput) {
  const result = await backendSDK(access).updateWorkspace(input)
  return { organization: result.organization, settings: fromBackendSettings(result.settings) }
}

export async function updateWorkspaceAiSettings(
  access: OrganizationAccess,
  input: WorkspaceAiSettingsUpdateInput
) {
  const result = await backendSDK(access).updateWorkspaceAiSettings({
    ...(input.aiAgentEnabled !== undefined ? { aiAgentEnabled: input.aiAgentEnabled } : {}),
    ...(input.aiModelDefaults !== undefined ? { aiModelDefaults: input.aiModelDefaults } : {}),
    ...(input.aiInstructions !== undefined ? { aiInstructions: input.aiInstructions } : {}),
    ...(input.aiProviderApiKey !== undefined ? { aiProviderApiKey: input.aiProviderApiKey } : {}),
  })
  return { organization: result.organization, settings: fromBackendSettings(result.settings) }
}

/**
 * Computes workspace readiness steps, active AI model defaults, and pinnable
 * context items (brand kits, product surfaces, campaigns) in one parallel read.
 */
export async function getWorkspaceReadiness(access: OrganizationAccess) {
  const sdk = backendSDK(access)
  const [workspaceRes, product, brand, storedKits, surfaces, campaigns, apiKeyRows] =
    await Promise.all([
      sdk.getWorkspace(),
      getProductProfile(access).catch(() => null),
      getBrandProfile(access).catch(() => null),
      listBrandKits(access).catch((): Awaited<ReturnType<typeof listBrandKits>> => []),
      listProductSurfaces(access).catch((): Awaited<ReturnType<typeof listProductSurfaces>> => []),
      listCampaigns(access, { limit: 12 }).catch((): Awaited<ReturnType<typeof listCampaigns>> => []),
      serviceBackend()
        .authStore({
          model: 'apikey',
          op: 'findMany',
          select: ['enabled', 'id'],
          where: [{ field: 'referenceId', value: access.organizationId }],
        })
        .then((res) => (res.rows ?? []) as { enabled: boolean | null; id: string }[])
        .catch((): { enabled: boolean | null; id: string }[] => []),
    ])

  const parsedKits = brandKitLibrary(
    storedKits.flatMap((kit) => {
      const parsed = storedBrandKitSchema.safeParse(kit)
      return parsed.success ? [parsed.data] : []
    })
  )

  const hasProductAndVoice = Boolean(
    product?.summary?.trim() || brand?.productDescription?.trim() || brand?.tone?.trim()
  )
  const hasBrandKit = parsedKits.length > 0
  const hasSurfaces = surfaces.length > 0
  const hasAgentOrCampaign =
    campaigns.length > 0 || apiKeyRows.some((key) => key.enabled !== false)

  const steps = [
    {
      done: hasProductAndVoice,
      href: '/settings/product',
      id: 'product-voice',
      label: 'Verify product & brand voice',
    },
    {
      done: hasBrandKit,
      href: '/settings/brand-kit',
      id: 'brand-kit',
      label: 'Create a visual brand kit',
    },
    {
      done: hasSurfaces,
      href: '/settings/product-pages',
      id: 'product-surfaces',
      label: 'Add a product page to capture',
    },
    {
      done: hasAgentOrCampaign,
      href: '/settings/ai-agents',
      id: 'agents-or-campaign',
      label: 'Start a campaign or connect an agent',
    },
  ]

  const settings = workspaceRes.workspace?.workspaceSettings ?? null
  return {
    aiAgentEnabled: settings?.aiAgentEnabled ?? true,
    aiModelDefaults: parseWorkspaceAiDefaults(settings?.aiModelDefaults),
    aiProviderKeyHint: settings?.aiProviderKeyHint ?? null,
    brandKits: parsedKits.slice(0, 12).map((kit) => ({ id: kit.id, name: kit.name })),
    campaigns: campaigns.slice(0, 12).map((item) => ({
      id: item.id,
      name: item.name,
    })),
    completed: steps.filter((step) => step.done).length,
    hasAiProviderKey: Boolean(settings?.hasAiProviderKey),
    hasCustomInstructions: Boolean(settings?.aiInstructions?.trim()),
    steps,
    surfaces: surfaces.slice(0, 12).map((item) => ({
      id: item.id,
      name: item.name,
    })),
    total: steps.length,
  }
}

export async function listWorkspaceMembers(access: OrganizationAccess) {
  const result = await backendSDK(access).listWorkspaceMembers()
  return result.members.map((item) => ({
    ...item,
    createdAt: new Date(item.createdAt),
    role: normalizeOrganizationRole(item.role),
  }))
}

export async function listWorkspaceInvitations(access: OrganizationAccess) {
  const result = await backendSDK(access).listWorkspaceInvitations()
  return result.invitations.map((item) => ({
    ...item,
    createdAt: new Date(item.createdAt),
    expiresAt: new Date(item.expiresAt),
    role: item.role ? normalizeOrganizationRole(item.role) : null,
  }))
}

export async function inviteWorkspaceMember(
  access: OrganizationAccess,
  input: WorkspaceInviteInput
) {
  return fromBackendInvitationDetail(await backendSDK(access).inviteWorkspaceMember(input))
}

export async function resendWorkspaceInvitation(access: OrganizationAccess, invitationId: string) {
  return fromBackendInvitationDetail(
    await backendSDK(access).resendWorkspaceInvitation(invitationId)
  )
}

export async function revokeWorkspaceInvitation(access: OrganizationAccess, invitationId: string) {
  return backendSDK(access).revokeWorkspaceInvitation(invitationId)
}

export async function updateWorkspaceMemberRole(
  access: OrganizationAccess,
  memberId: string,
  role: string
) {
  const updated = await backendSDK(access).updateWorkspaceMemberRole(memberId, role)
  return {
    ...updated,
    createdAt: new Date(updated.createdAt),
    role: normalizeOrganizationRole(updated.role),
  }
}

export async function removeWorkspaceMember(access: OrganizationAccess, memberId: string) {
  await backendSDK(access).removeWorkspaceMember(memberId)
  return
}

export async function leaveWorkspace(access: OrganizationAccess) {
  await backendSDK(access).leaveWorkspace()
  return
}

export async function transferWorkspaceOwnership(access: OrganizationAccess, memberId: string) {
  await backendSDK(access).transferWorkspaceOwnership(memberId)
  return
}

export async function requestWorkspaceDeletion(access: OrganizationAccess, confirmation: string) {
  return fromBackendDeletion(await backendSDK(access).requestWorkspaceDeletion(confirmation))
}

export async function cancelWorkspaceDeletion(access: SessionAccess) {
  return fromBackendDeletion(
    await backendSDK({ ...access, organizationId: '' }).cancelWorkspaceDeletion()
  )
}

import { z } from 'zod'
import type { BackendCurrentUser, ListedWorkspace } from 'screenshot-studio-backend-sdk'
import {
  organizationRoleSchema,
  permissionSchema,
  requestedOrganizationSchema,
} from '@/lib/api/access-requirements'
import { type ContractDocs, defineContract, mirrors, timestampSchema } from '@/lib/api/contract'
import type { PlaybookBootstrap, PlaybookCapabilities } from '@/lib/core/bootstrap-shape'
import type { listWorkspaceInvitations, listWorkspaceMembers } from '@/lib/workspace/service'

/**
 * Shell contracts: the signed-in user and their organizations, served under
 * `/api/v1` to every Playbook shell (web, Wanta, OpenWhispr, CLI). They take
 * a session only and refuse API keys.
 */

function shellDocs(operationId: string, description: string, outputName?: string): ContractDocs {
  return {
    description,
    operationId,
    outputName,
    responses: {
      '200': 'The resolved resource.',
      '401': 'A signed-in user session is required.',
      '403':
        'The user is not a member of the active organization, lacks the permission, or sent an API key.',
      '503': 'A required dependency is unavailable.',
    },
    security: 'workspaceSession',
    tag: 'Shell',
  }
}

/** Organization capability flags; rendering hints only. */
export const playbookCapabilitiesSchema = mirrors<PlaybookCapabilities>()(
  z.object({
    browserAutomation: z.boolean(),
    engineeringAgent: z.boolean(),
    publishing: z.boolean(),
    voiceCapture: z.boolean(),
    workflows: z.boolean(),
  })
)

/** The safe entitlement view a shell may render. */
export const playbookEntitlementsSchema = z.object({
  features: z.record(z.string(), z.boolean()),
  plan: z.string(),
  status: z.string(),
})

/** Everything a shell needs to render the active organization. */
export const playbookBootstrapSchema = mirrors<PlaybookBootstrap>()(
  z.object({
    capabilities: playbookCapabilitiesSchema,
    counters: z.object({ approvals: z.number(), attention: z.number() }),
    entitlements: playbookEntitlementsSchema,
    membership: z.object({ permissions: z.array(z.string()), role: z.string() }),
    organization: z.object({
      id: z.string(),
      logo: z.string().nullable(),
      name: z.string(),
      slug: z.string(),
    }),
    organizations: z.array(
      z.object({ id: z.string(), name: z.string(), role: z.string(), slug: z.string() })
    ),
    user: z.object({ email: z.string(), id: z.string(), name: z.string().nullable() }),
    workspace: z.object({
      defaultPublishTime: z.string(),
      locale: z.string(),
      timeZone: z.string(),
    }),
  })
)

/** `GET /api/v1/me` */
export const getCurrentUserContract = defineContract({
  docs: shellDocs(
    'getCurrentUser',
    'Returns the id, name, email, and avatar of the user behind the session cookie.'
  ),
  method: 'GET',
  name: 'me',
  output: z.object({
    user: mirrors<BackendCurrentUser>()(
      z.object({
        email: z.string(),
        id: z.string(),
        image: z.string().nullable(),
        name: z.string().nullable(),
      })
    ),
  }),
  path: '/api/v1/me',
  shell: true,
  summary: 'Get the signed-in user',
})

/** `GET /api/v1/bootstrap` */
export const getBootstrapContract = defineContract({
  docs: shellDocs(
    'getShellBootstrap',
    'Returns the user, active organization, memberships, resolved permissions, workspace settings, entitlements, capabilities, and counters. Call after sign-in and again after any 401 or 403.',
    'PlaybookBootstrap'
  ),
  method: 'GET',
  name: 'bootstrap',
  output: playbookBootstrapSchema,
  path: '/api/v1/bootstrap',
  shell: true,
  summary: 'Bootstrap a Playbook shell',
})

/** `GET /api/v1/organizations` */
export const listOrganizationsContract = defineContract({
  docs: shellDocs(
    'listOrganizations',
    'Lists every organization the signed-in user belongs to, with their normalized role in each.'
  ),
  method: 'GET',
  name: 'organizations.list',
  output: z.object({
    organizations: z.array(
      mirrors<ListedWorkspace>()(
        z.object({
          id: z.string(),
          isScheduledForDeletion: z.boolean(),
          name: z.string(),
          role: z.string(),
          slug: z.string(),
          workspaceDeletion: z
            .object({ requestedByUserId: z.string(), scheduledFor: z.string(), status: z.string() })
            .optional(),
        })
      )
    ),
  }),
  path: '/api/v1/organizations',
  shell: true,
  summary: 'List the user organizations',
})

/** `GET /api/v1/organizations/{organizationId}` */
export const getOrganizationContract = defineContract({
  docs: shellDocs(
    'getOrganization',
    'Returns identity fields for the organization. The organization must be the active one; activate it first otherwise.'
  ),
  method: 'GET',
  name: 'organizations.get',
  output: z.object({
    organization: z.object({
      // The backend's `GET /v1/workspace` does not send it today, so it stays optional.
      createdAt: z.string().optional(),
      id: z.string(),
      logo: z.string().nullable(),
      name: z.string(),
      role: organizationRoleSchema,
      slug: z.string(),
    }),
  }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}',
  shell: true,
  summary: 'Get the active organization',
})

/** `GET /api/v1/organizations/{organizationId}/members` */
export const listOrganizationMembersContract = defineContract({
  docs: shellDocs(
    'listOrganizationMembers',
    'Lists members and their roles in the active organization. Requires the member:read permission.'
  ),
  method: 'GET',
  name: 'organizations.members',
  output: z.object({
    members: mirrors<Awaited<ReturnType<typeof listWorkspaceMembers>>>()(
      z.array(
        z.object({
          createdAt: timestampSchema,
          id: z.string(),
          organizationId: z.string(),
          userId: z.string(),
          role: organizationRoleSchema,
          user: z.object({
            email: z.string(),
            id: z.string(),
            image: z.string().nullable(),
            name: z.string(),
          }),
        })
      )
    ),
  }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/members',
  shell: true,
  summary: 'List organization members',
})

/** `GET /api/v1/organizations/{organizationId}/invitations` */
export const listOrganizationInvitationsContract = defineContract({
  docs: shellDocs(
    'listOrganizationInvitations',
    'Lists invitations for the active organization. Requires the invitation:read permission.'
  ),
  method: 'GET',
  name: 'organizations.invitations',
  output: z.object({
    invitations: mirrors<Awaited<ReturnType<typeof listWorkspaceInvitations>>>()(
      z.array(
        z.object({
          createdAt: timestampSchema,
          email: z.string(),
          expiresAt: timestampSchema,
          id: z.string(),
          role: organizationRoleSchema.nullable(),
          status: z.string(),
        })
      )
    ),
  }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/invitations',
  shell: true,
  summary: 'List organization invitations',
})

/** Saved workspace settings, or the defaults when none are saved. */
export const workspaceSettingsSchema = z.object({
  releaseReadinessEnabled: z.boolean().optional(),
  createdAt: timestampSchema.optional(),
  defaultPublishTime: z.string(),
  description: z.string().nullable(),
  locale: z.string(),
  organizationId: z.string().optional(),
  timeZone: z.string(),
  updatedAt: timestampSchema.optional(),
})

/** `GET /api/v1/organizations/{organizationId}/settings` */
export const getOrganizationSettingsContract = defineContract({
  docs: shellDocs(
    'getOrganizationSettings',
    'Returns locale, time zone, default publishing time, and description for the active organization.'
  ),
  method: 'GET',
  name: 'organizations.settings',
  output: z.object({ settings: workspaceSettingsSchema }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/settings',
  shell: true,
  summary: 'Get workspace settings',
})

/** `GET /api/v1/organizations/{organizationId}/permissions` */
export const getOrganizationPermissionsContract = defineContract({
  docs: shellDocs(
    'getOrganizationPermissions',
    'Returns the normalized role and resolved permission list of the signed-in user in the active organization.'
  ),
  method: 'GET',
  name: 'organizations.permissions',
  output: z.object({
    permissions: z.array(permissionSchema).readonly(),
    role: organizationRoleSchema,
  }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/permissions',
  shell: true,
  summary: 'Get the user permissions',
})

/** `GET /api/v1/organizations/{organizationId}/capabilities` */
export const getOrganizationCapabilitiesContract = defineContract({
  docs: shellDocs(
    'getOrganizationCapabilities',
    'Returns capability flags and the safe entitlement view (plan, status, features) for the active organization.'
  ),
  method: 'GET',
  name: 'organizations.capabilities',
  output: z.object({
    capabilities: playbookCapabilitiesSchema,
    entitlements: playbookEntitlementsSchema,
  }),
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/capabilities',
  shell: true,
  summary: 'Get organization capabilities',
})

/** `POST /api/v1/organizations/{organizationId}/activate` */
export const activateOrganizationContract = defineContract({
  docs: shellDocs(
    'activateOrganization',
    'Makes the organization active for this session after checking membership and deletion state, then returns the refreshed bootstrap.',
    'PlaybookBootstrap'
  ),
  method: 'POST',
  name: 'organizations.activate',
  output: playbookBootstrapSchema,
  params: requestedOrganizationSchema,
  path: '/api/v1/organizations/{organizationId}/activate',
  shell: true,
  summary: 'Switch the active organization',
})

import 'server-only'

import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { founderHubSessionSchema } from 'screenshot-studio-backend-sdk'
import {
  type MemberAccessRequirement,
  memberAccessRequirementSchema,
} from '@/lib/api/access-requirements'
import { getRequestId } from '@/lib/api/request-context'
import { backendSDK } from '@/lib/backend/sdk'
import { consumeWorkspaceQuota, requireWorkspaceFeatures } from '@/lib/tenant/entitlements'
import { WorkspaceError } from '@/lib/workspace/errors'
import {
  assertPermission,
  AuthorizationError,
  type OrganizationAccess,
  requireSessionAccess,
} from './access'
import { assertAuthEnvironment, getAuthBaseUrl, getFounderHubMcpUrl } from './environment'
import { getRolePermissions, normalizeOrganizationRole } from './permissions'
import { auth } from './server'

/** Settings belong to the current person; bearer requests retain the native gateway and grant checks. */
export async function requireFounderHubSettingsAccess(headers: Headers) {
  if (!headers.has('authorization')) return requireSessionAccess(headers)
  return requireFounderHubDeviceAccess(headers)
}

/** Native reports and acknowledgements require a live delegated token and the private gateway. */
export async function requireFounderHubDeviceAccess(headers: Headers) {
  const claims = await verifyFounderHubClaims(headers)
  const principal = {
    kind: 'session' as const,
    display: '',
    userId: claims.sub,
    sessionId: claims.sid,
  }
  await backendSDK({
    organizationId: '',
    principal,
    requestId: getRequestId(headers),
  }).authorizeFounderHubSession()
  return {
    requestId: getRequestId(headers),
    principal,
  }
}

/**
 * The Founder Hub member of the workspace the gateway names in
 * `x-shots-organization-id`, held to `requirement` as `memberAccess` holds a
 * browser member: role, permission groups, plan features and quota. The phone
 * only knows the Founder Hub workspace id, so it maps to an organization
 * through the person's authority snapshot; the backend then checks the
 * client's live grant and the membership again on every call.
 */
export async function requireFounderHubMemberAccess(
  headers: Headers,
  requirement: MemberAccessRequirement
): Promise<OrganizationAccess> {
  const { feature, permission, quota, sensitive } = memberAccessRequirementSchema.parse(requirement)
  // shortcut: reads the whole authority snapshot per call, add a one-workspace lookup if sync latency matters.
  const session = await requireFounderHubAccess(headers)
  // A missing or malformed workspace id is a bad request (400).
  const workspaceId = z.uuid().parse(headers.get('x-shots-organization-id'))
  // Only the person's own workspaces map; any other id is not found, so none leaks.
  const workspace = session.workspaces.find((item) => item.workspaceId === workspaceId)
  if (!workspace) throw new WorkspaceError('The workspace was not found.', 404)
  if (sensitive) throw new AuthorizationError('A fresh browser sign-in is required.', 403)
  const access: OrganizationAccess = {
    deniedPermissions: workspace.deniedPermissions,
    organizationId: workspace.organizationId,
    principal: {
      client: 'shots-founder-hub',
      display: '',
      kind: 'session',
      sessionId: session.sessionId,
      userId: session.user.id,
    },
    requestId: getRequestId(headers),
    role: normalizeOrganizationRole(workspace.role),
  }
  assertPermission(access, permission)
  await requireWorkspaceFeatures(access, feature ? ['workspace:use', feature] : ['workspace:use'])
  if (quota) await consumeWorkspaceQuota(access, quota)
  return access
}

function founderHubAudienceSchema(audience: string) {
  const userInfo = new URL('/api/auth/oauth2/userinfo', getAuthBaseUrl()).toString()
  return z.union([z.string(), z.array(z.string())]).refine((value) => {
    const audiences = typeof value === 'string' ? [value] : value
    return (
      audiences.includes(audience) &&
      audiences.every((item) => item === audience || item === userInfo)
    )
  })
}

const founderHubClaimsSchema = z.object({
  sub: z.string().min(1),
  sid: z.string().min(1),
  azp: z.literal('shots-founder-hub'),
  aud: founderHubAudienceSchema(new URL('/api/founder-hub', getAuthBaseUrl()).toString()),
  scope: z
    .string()
    .refine((scope) =>
      ['founder-hub', 'offline_access'].every((required) => scope.split(' ').includes(required))
    ),
})

/** Private authority is available only to the configured Founder Hub service. */
export function requireFounderHubService(headers: Headers) {
  assertAuthEnvironment()
  const expected = z.string().min(32).safeParse(process.env.SHOTS_AUTH_SERVICE_TOKEN)
  const serviceToken = headers.get('x-shots-founder-hub-service') ?? ''
  if (
    !expected.success ||
    Buffer.byteLength(serviceToken) !== Buffer.byteLength(expected.data) ||
    !timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expected.data))
  ) {
    throw new AuthorizationError('Founder Hub gateway authentication is required.', 403)
  }
}

/** Only the trusted Hub gateway may resolve private authority using a live native OAuth credential. */
export async function requireFounderHubAccess(headers: Headers) {
  const claims = await verifyFounderHubClaims(headers)
  const session = await backendSDK({
    organizationId: '',
    principal: {
      kind: 'session',
      display: '',
      userId: claims.sub,
      sessionId: claims.sid,
    },
    requestId: getRequestId(headers),
  }).getFounderHubSession()
  return withFounderHubPermissions(session)
}

async function verifyFounderHubClaims(headers: Headers) {
  requireFounderHubService(headers)
  const authorization = headers.get('authorization')
  if (!authorization?.startsWith('Bearer ') || authorization.length > 16384) {
    throw new AuthorizationError('A Founder Hub access token is required.', 401)
  }
  const { payload } = await auth.api.verifyJWT({ body: { token: authorization.slice(7) } })
  const claims = founderHubClaimsSchema.safeParse(payload)
  if (!claims.success) throw new AuthorizationError('The Founder Hub token is invalid.', 401)
  return claims.data
}

/** A connector can read opted-in snapshots; it cannot use native account or storage APIs. */
export async function requireFounderHubConnectorAccess(headers: Headers) {
  requireFounderHubService(headers)
  const audience = getFounderHubMcpUrl()
  const authorization = headers.get('authorization')
  if (!audience || !authorization?.startsWith('Bearer ') || authorization.length > 16384) {
    throw new AuthorizationError('A Founder Hub connector token is required.', 401)
  }
  const { payload } = await auth.api.verifyJWT({ body: { token: authorization.slice(7) } })
  const claims = z
    .object({
      sub: z.string().min(1),
      sid: z.string().min(1),
      aud: founderHubAudienceSchema(audience),
      azp: z
        .string()
        .min(1)
        .max(160)
        .refine((value) => value !== 'shots-founder-hub'),
      scope: z
        .string()
        .refine((value) =>
          ['founder-hub:meetings:read', 'offline_access'].every((scope) =>
            value.split(' ').includes(scope)
          )
        ),
    })
    .safeParse(payload)
  if (!claims.success) throw new AuthorizationError('The connector token is invalid.', 401)
  const session = await backendSDK({
    organizationId: '',
    requestId: getRequestId(headers),
    principal: {
      kind: 'session',
      display: '',
      userId: claims.data.sub,
      sessionId: claims.data.sid,
    },
  }).getFounderHubConnectorSession(claims.data.azp)
  return withFounderHubPermissions(session)
}

/** Apply current role ceilings and explicit permission denials to a private authority snapshot. */
export function withFounderHubPermissions(session: z.infer<typeof founderHubSessionSchema>) {
  return {
    ...session,
    workspaces: session.workspaces.map((workspace) => ({
      ...workspace,
      permissions: getRolePermissions(workspace.role).filter(
        (permission) => !workspace.deniedPermissions.includes(permission)
      ),
      members: workspace.members.map((member) => ({
        ...member,
        permissions: getRolePermissions(member.role).filter(
          (permission) => !member.deniedPermissions.includes(permission)
        ),
      })),
    })),
  }
}

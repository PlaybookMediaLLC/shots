import 'server-only'

import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { founderHubSessionSchema } from 'screenshot-studio-backend-sdk'
import { getRequestId } from '@/lib/api/request-context'
import { backendSDK } from '@/lib/backend/sdk'
import { AuthorizationError, requireSessionAccess } from './access'
import { assertAuthEnvironment, getAuthBaseUrl, getFounderHubMcpUrl } from './environment'
import { getRolePermissions } from './permissions'
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

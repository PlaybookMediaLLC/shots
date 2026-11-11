import { toNextJsHandler } from 'better-auth/next-js'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { getClientIdentifier } from '@/lib/api/client-identity'
import { rateLimitHeaders } from '@/lib/api/platform-errors'
import { AuthorizationError, resolveActiveOrganizationId } from '@/lib/auth/access'
import { assertAuthEnvironment } from '@/lib/auth/environment'
import {
  authorizeAuthEndpointPermission,
  authorizeEnterpriseAuthRequest,
  logEnterpriseAuthRequest,
} from '@/lib/auth/enterprise-guard'
import { auth } from '@/lib/auth/server'
import {
  AUTH_RATE_LIMIT,
  OAUTH_TOKEN_RATE_LIMIT,
  type RateLimitPolicy,
  WORKSPACE_INVITATION_RATE_LIMIT,
} from '@/lib/api/rate-limit-policy'
import { serviceBackend } from '@/lib/backend/sdk'
import { checkRateLimit } from '@/lib/rate-limit'
import { isWorkspaceOperational } from '@/lib/workspace/access'
import { withBoundedBody, RequestBodyTooLargeError } from '@/lib/security/request-body'

/**
 * Only credential-bearing endpoints are throttled. Session reads run on
 * every page load, so limiting them would break normal browsing, and they
 * are not a credential-guessing surface.
 */
const rateLimitedAuthPathSchema = z.enum([
  '/sign-in',
  '/sign-up',
  '/forget-password',
  '/reset-password',
  '/change-password',
  '/two-factor',
])

/** Member invitations get their own, per-actor budget. */
const invitationPath = '/organization/invite-member'

/** Organization endpoints that must refuse a workspace scheduled for deletion. */
const operationalOrganizationPathSchema = z.enum([
  '/organization/add-member',
  '/organization/get-active-member',
  '/organization/get-full-organization',
  '/organization/invite-member',
  '/organization/leave',
  '/organization/list-invitations',
  '/organization/list-members',
  '/organization/remove-member',
  '/organization/set-active',
  '/organization/update',
  '/organization/update-member-role',
])

/** The organization a Better Auth organization request names, if any. */
const organizationRequestInputSchema = z
  .object({
    organizationId: z.string().optional().catch(undefined),
    organizationSlug: z.string().optional().catch(undefined),
  })
  .catch({})

type OrganizationRequestInput = z.infer<typeof organizationRequestInputSchema>

async function readOrganizationRequestBody(request: Request): Promise<unknown> {
  try {
    return await request.clone().json()
  } catch {
    return {}
  }
}

async function getOrganizationRequestInput(request: Request): Promise<OrganizationRequestInput> {
  const input =
    request.method === 'GET'
      ? Object.fromEntries(new URL(request.url).searchParams)
      : await readOrganizationRequestBody(request)
  return organizationRequestInputSchema.parse(input)
}

async function resolveRequestedOrganizationId(
  input: OrganizationRequestInput,
  activeOrganizationId: string | null | undefined
): Promise<string | null> {
  if (input.organizationId !== undefined) return input.organizationId
  if (input.organizationSlug !== undefined) {
    const { row } = await serviceBackend().authStore({
      model: 'organization',
      op: 'findOne',
      select: ['id'],
      where: [{ field: 'slug', value: input.organizationSlug }],
    })
    return typeof row?.id === 'string' ? row.id : null
  }
  return activeOrganizationId ?? null
}

async function getRequestedWorkspaceId(request: Request): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  })
  if (!session) return null

  const input = await getOrganizationRequestInput(request)
  const organizationId = await resolveRequestedOrganizationId(
    input,
    session.session.activeOrganizationId
  )
  if (!organizationId) return null

  const { row } = await serviceBackend().authStore({
    model: 'member',
    op: 'findOne',
    select: ['organizationId'],
    where: [
      { field: 'organizationId', value: organizationId },
      { field: 'userId', value: session.user.id },
    ],
  })
  return typeof row?.organizationId === 'string' ? row.organizationId : null
}

async function enforceOperationalOrganization(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  if (!operationalOrganizationPathSchema.options.some((path) => pathname.endsWith(path))) {
    return null
  }

  const organizationId = await getRequestedWorkspaceId(request)
  if (organizationId && !(await isWorkspaceOperational(organizationId))) {
    return Response.json({ error: 'This workspace is unavailable.' }, { status: 403 })
  }
  return null
}

async function ensureActiveOrganizationForSessionRead(request: Request): Promise<void> {
  if (!new URL(request.url).pathname.endsWith('/get-session')) {
    return
  }

  const session = await auth.api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  })
  if (session) {
    await resolveActiveOrganizationId(session.session, session.user.id)
  }
}

function getAuthRateLimitPolicy(request: Request): RateLimitPolicy | null {
  if (request.method !== 'POST') {
    return null
  }

  const { pathname } = new URL(request.url)
  if (pathname.endsWith('/oauth2/token')) return OAUTH_TOKEN_RATE_LIMIT
  if (pathname.includes(invitationPath)) {
    return WORKSPACE_INVITATION_RATE_LIMIT
  }
  return rateLimitedAuthPathSchema.options.some((path) => pathname.includes(path))
    ? AUTH_RATE_LIMIT
    : null
}

function getRateLimitResponse(policy: RateLimitPolicy, resetAt: number): Response {
  return Response.json(
    { error: 'Too many attempts. Please try again shortly.' },
    { headers: rateLimitHeaders(policy.maxRequests, resetAt), status: 429 }
  )
}

/**
 * Returns a 429 when the caller is over budget, or null to continue.
 *
 * A Redis outage must not lock every user out of signing in, so a failed
 * check is logged and allowed through. The tradeoff is deliberate:
 * availability of authentication is worth more than throttling during the
 * window where the cache is unreachable.
 */
async function enforceAuthRateLimit(request: Request): Promise<Response | null> {
  const policy = getAuthRateLimitPolicy(request)
  if (!policy) {
    return null
  }

  try {
    const rateLimit = await checkRateLimit(getClientIdentifier(request.headers), policy)
    return rateLimit.allowed ? null : getRateLimitResponse(policy, rateLimit.resetAt)
  } catch (error) {
    console.error('Auth rate limit check failed; allowing request.', error)
    return null
  }
}

function authFailureResponse(error: unknown): Response | null {
  if (error instanceof RequestBodyTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 })
  }
  if (error instanceof AuthorizationError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  if (error instanceof BackendSDKError && error.status === 409) {
    return Response.json({ error: 'This record already exists.' }, { status: 409 })
  }
  return null
}

const handler = toNextJsHandler({
  handler: async (request: Request): Promise<Response> => {
    try {
      assertAuthEnvironment()

      const rateLimited = await enforceAuthRateLimit(request)
      if (rateLimited) {
        return rateLimited
      }

      request = await withBoundedBody(request)

      const unavailableWorkspace = await enforceOperationalOrganization(request)
      if (unavailableWorkspace) {
        return unavailableWorkspace
      }

      await ensureActiveOrganizationForSessionRead(request)

      await authorizeAuthEndpointPermission(request)
      const enterpriseRequest = await authorizeEnterpriseAuthRequest(request)
      const response = await auth.handler(request)
      if (enterpriseRequest && response.ok) {
        try {
          await logEnterpriseAuthRequest(request, enterpriseRequest)
        } catch (error) {
          console.error('Enterprise identity audit write failed.', error)
        }
      }
      return response
    } catch (error) {
      const response = authFailureResponse(error)
      if (response) return response
      throw error
    }
  },
})

/**
 * Better Auth's handler, behind credential rate limits, the deleted-workspace
 * guard, and enterprise identity audit logging.
 */
export const { DELETE, GET, PATCH, POST, PUT } = handler

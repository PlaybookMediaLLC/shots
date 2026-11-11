import { z } from 'zod'
import { API_DOCS_URL, type ApiErrorCode } from '@/lib/api/errors'
import {
  workspaceFeatureSchema,
  workspacePlanSchema,
  workspaceQuotaSchema,
} from '@/lib/billing/plans'

/**
 * The one mapping from a thrown error to an HTTP failure, shared by the
 * platform REST routes (`lib/api/route.ts`) and tRPC (`lib/trpc/errors.ts`).
 *
 * Errors are matched by zod schemas on their `name` and shape rather than
 * `instanceof`, so this module imports no server-only code and stays testable
 * under plain Node.
 */

/**
 * Stable machine-readable error codes on the platform API. A superset of the
 * upstream editor's `ApiErrorCode` that adds `conflict`.
 */
export const platformErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_url',
  'unsupported_value',
  'unauthorized',
  'forbidden',
  'forbidden_domain',
  'not_found',
  'method_not_allowed',
  'conflict',
  'rate_limited',
  'workspace_feature_not_entitled',
  'workspace_quota_exceeded',
  'upstream_timeout',
  'upstream_unavailable',
  'upstream_failed',
  'internal_error',
])

/** One of {@link platformErrorCodeSchema}. */
export type PlatformErrorCode = z.infer<typeof platformErrorCodeSchema>

// Compile-time check: every upstream editor error code is a platform error code.
const _upstreamCodesCovered = (code: ApiErrorCode): PlatformErrorCode => code

/** The JSON envelope every failing platform request returns. */
export const platformErrorBodySchema = z
  .object({
    code: platformErrorCodeSchema.describe('Stable machine-readable error code.'),
    documentation: z.url().describe('Link to the error reference.'),
    error: z
      .string()
      .meta({ description: 'Human-readable error message.', examples: ['URL is required'] }),
    hint: z.string().describe('How to resolve the error.'),
    message: z.string().describe('Human-readable error message, same value as `error`.'),
    status: z.int().describe('HTTP status code, repeated in the body.'),
  })
  .describe(
    'Every failing request returns this envelope. `code` is stable and safe to branch on; `error` and `message` carry the same human-readable text.'
  )

/** One of {@link platformErrorBodySchema}. */
export type PlatformErrorBody = z.infer<typeof platformErrorBodySchema>

/** HTTP error statuses with a specific platform code and hint. */
export const httpErrorStatusSchema = z.literal([400, 401, 403, 404, 409, 413, 422, 429, 500, 503])

/** One of {@link httpErrorStatusSchema}. */
export type HttpErrorStatus = z.infer<typeof httpErrorStatusSchema>

/** A resolved failure, ready to render as {@link platformErrorBodySchema}. */
export const apiFailureSchema = z.object({
  code: platformErrorCodeSchema,
  /** Extra envelope fields, such as a quota's `limit`. */
  extra: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  hint: z.string(),
  message: z.string(),
  status: z.int().min(400).max(599),
})

/** One of {@link apiFailureSchema}. */
export type ApiFailure = z.infer<typeof apiFailureSchema>

/** The code and hint a status contributes to a failure. */
export const failureDetailsSchema = apiFailureSchema.pick({ code: true, hint: true })

/** One of {@link failureDetailsSchema}. */
export type FailureDetails = z.infer<typeof failureDetailsSchema>

const statusDetails: Record<HttpErrorStatus, FailureDetails> = {
  413: {
    code: 'invalid_request',
    hint: 'Reduce the request size or upload media through the signed asset upload endpoint.',
  },
  400: {
    code: 'invalid_request',
    hint: 'Check the request body, query parameters, and path values against the OpenAPI schema.',
  },
  401: {
    code: 'unauthorized',
    hint: 'Send a valid X-API-Key header or sign in to an authorized workspace session.',
  },
  403: {
    code: 'forbidden',
    hint: 'Use credentials with the required workspace permission, API-key scope, and plan access.',
  },
  404: { code: 'not_found', hint: 'Check the resource identifier and workspace context.' },
  409: { code: 'conflict', hint: 'Reload the resource to see its current state, then retry.' },
  422: { code: 'invalid_request', hint: 'Fix the request so it satisfies the resource rules.' },
  429: { code: 'rate_limited', hint: 'Wait for the indicated reset time, then retry.' },
  500: {
    code: 'internal_error',
    hint: 'Retry the request. If it keeps failing, contact support.',
  },
  503: { code: 'upstream_unavailable', hint: 'Retry later with exponential backoff.' },
}

/** Domain errors whose own `status` and `message` are safe to return to callers. */
export const statusErrorNameSchema = z.enum([
  'RequestBodyTooLargeError',
  'AnnouncementError',
  'AuthorizationError',
  'BackendSDKError',
  'BillingError',
  'CampaignError',
  'CreativeWorkflowError',
  'DesignError',
  'LaunchError',
  'ReleaseError',
  'ScheduledPostError',
  'WorkspaceEntitlementError',
  'WorkspaceError',
  'WorkspaceQuotaError',
])

/** Errors that mean the request itself is malformed; their message is returned as is. */
export const requestErrorNameSchema = z.enum([
  'InvalidTenantObjectKeyError',
  'TenantStorageObjectMissingError',
])

/** Errors that mean a dependency is down; their message is replaced with a generic one. */
export const dependencyErrorNameSchema = z.enum(['TenantStorageUnavailableError'])

/** Validation failures; their details are never returned. */
export const validationErrorNameSchema = z.enum(['SyntaxError', 'ZodError'])

const namedErrorSchema = z.object({ message: z.string(), name: z.string() })

const statusErrorSchema = z.object({
  message: z.string(),
  name: statusErrorNameSchema,
  status: apiFailureSchema.shape.status,
})

const quotaErrorSchema = z.object({
  limit: z.number(),
  message: z.string(),
  name: z.literal('WorkspaceQuotaError'),
  quota: workspaceQuotaSchema,
  resetAt: z.number(),
})

const entitlementSchema = z.object({
  currentPlan: workspacePlanSchema,
  feature: workspaceFeatureSchema,
  requiredPlan: workspacePlanSchema,
})

const entitlementErrorSchema = z.union([
  entitlementSchema.extend({
    message: z.string(),
    name: z.literal('WorkspaceEntitlementError'),
  }),
  // The backend reports a plan gate as a 403 whose body carries the decision.
  z
    .object({
      details: entitlementSchema.extend({ code: z.literal('workspace_feature_not_entitled') }),
      message: z.string(),
      name: z.literal('BackendSDKError'),
    })
    .transform(({ details, message }) => ({ ...details, message })),
])

// A reviewed queue slot another schedule took: the backend names the next free slot.
const queueSlotTakenSchema = z.object({
  details: z.object({ code: z.literal('queue_slot_taken'), nextQueueSlot: z.iso.datetime() }),
  message: z.string(),
  name: z.literal('BackendSDKError'),
})

/** An account's queued or published post that a schedule would repeat within a day. */
export const duplicatePostSchema = z.object({
  at: z.iso.datetime({ offset: true }),
  channelConnectionId: z.string(),
  postId: z.string(),
  status: z.string(),
})

// An account already has the same text and media queued or published within a day.
const duplicateContentSchema = z.object({
  details: z.object({
    code: z.literal('duplicate_content'),
    duplicates: z.array(duplicatePostSchema).min(1),
  }),
  message: z.string(),
  name: z.literal('BackendSDKError'),
})

// Better Auth reports an unreachable backend auth store with this body code.
const sessionStoreUnavailableSchema = z.object({
  body: z.object({ code: z.literal('FAILED_TO_GET_SESSION') }),
})

const DEPENDENCY_UNAVAILABLE = 'A required dependency is unavailable.'
const INVALID_REQUEST = 'Invalid request.'

/** The standard code and hint for `status`, with `message` as the human text. */
export function failureForStatus(status: number, message: string): ApiFailure {
  const known = httpErrorStatusSchema.safeParse(status)
  return { ...statusDetails[known.success ? known.data : 500], message, status }
}

/** The documented error envelope for a resolved failure. */
export function toErrorBody(failure: ApiFailure): PlatformErrorBody {
  return {
    code: failure.code,
    documentation: `${API_DOCS_URL}#errors`,
    error: failure.message,
    hint: failure.hint,
    message: failure.message,
    status: failure.status,
  }
}

/** `Retry-After` and `X-RateLimit-*` headers for a 429, as the OpenAPI spec documents them. */
export function rateLimitHeaders(limit: number, resetAt: number): Record<string, string> {
  return {
    'Retry-After': String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000))),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(resetAt),
  }
}

function getQuotaFailure(error: unknown): ApiFailure | null {
  const parsed = quotaErrorSchema.safeParse(error)
  if (!parsed.success) return null
  const { limit, message, quota, resetAt } = parsed.data
  return {
    ...failureForStatus(429, message),
    code: 'workspace_quota_exceeded',
    extra: { limit, quota },
    headers: rateLimitHeaders(limit, resetAt),
  }
}

function getEntitlementFailure(error: unknown): ApiFailure | null {
  const parsed = entitlementErrorSchema.safeParse(error)
  if (!parsed.success) return null
  const { currentPlan, feature, message, requiredPlan } = parsed.data
  return {
    code: 'workspace_feature_not_entitled',
    extra: { currentPlan, feature, requiredPlan },
    headers: { 'x-current-plan': currentPlan, 'x-required-plan': requiredPlan },
    hint: `Upgrade to ${requiredPlan} or ask a workspace owner to review the contract entitlement.`,
    message,
    status: 403,
  }
}

function getDuplicateContentFailure(error: unknown): ApiFailure | null {
  const parsed = duplicateContentSchema.safeParse(error)
  if (!parsed.success) return null
  const { details, message } = parsed.data
  return {
    ...failureForStatus(409, message),
    extra: { duplicates: details.duplicates },
  }
}

function getQueueSlotFailure(error: unknown): ApiFailure | null {
  const parsed = queueSlotTakenSchema.safeParse(error)
  if (!parsed.success) return null
  const { details, message } = parsed.data
  return { ...failureForStatus(409, message), extra: { nextQueueSlot: details.nextQueueSlot } }
}

function getNamedFailure(error: unknown): ApiFailure | null {
  const named = namedErrorSchema.safeParse(error)
  if (!named.success) return null
  const { message, name } = named.data
  if (validationErrorNameSchema.safeParse(name).success) {
    return failureForStatus(400, INVALID_REQUEST)
  }
  if (requestErrorNameSchema.safeParse(name).success) return failureForStatus(400, message)
  if (dependencyErrorNameSchema.safeParse(name).success) {
    return failureForStatus(503, DEPENDENCY_UNAVAILABLE)
  }
  const status = statusErrorSchema.safeParse(error)
  return status.success ? failureForStatus(status.data.status, message) : null
}

/**
 * Resolve a thrown error to the failure callers should see, or `null` when
 * the error is unexpected and must surface as a logged 500.
 */
export function toApiFailure(error: unknown): ApiFailure | null {
  if (sessionStoreUnavailableSchema.safeParse(error).success) {
    return failureForStatus(503, DEPENDENCY_UNAVAILABLE)
  }
  return (
    getQuotaFailure(error) ??
    getEntitlementFailure(error) ??
    getQueueSlotFailure(error) ??
    getDuplicateContentFailure(error) ??
    getNamedFailure(error)
  )
}

const planRefusalSchema = z.union([
  // lib/settings/client.ts
  z.object({ code: z.literal('workspace_feature_not_entitled') }),
  // lib/content-drafts/client.ts
  z.object({ details: z.object({ code: z.literal('workspace_feature_not_entitled') }) }),
  // tRPC, through `platformErrorCode` in lib/trpc/errors.ts
  z.object({ data: z.object({ platformCode: z.literal('workspace_feature_not_entitled') }) }),
])

/** What a plan refusal says where only text fits, such as a toast or an inline error. */
export const PLAN_REFUSAL_MESSAGE =
  "The workspace's plan does not include this. Choose a plan in Settings → Billing."

/**
 * Whether a request from the browser failed because the workspace's plan
 * does not include it, whichever client made it. A plan refusal is final
 * until the plan changes, so the page offers a plan rather than a retry.
 */
export function isPlanRefusal(error: unknown): boolean {
  return planRefusalSchema.safeParse(error).success
}

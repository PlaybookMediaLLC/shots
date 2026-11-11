import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  failureForStatus,
  isPlanRefusal,
  PLAN_REFUSAL_MESSAGE,
  rateLimitHeaders,
  toApiFailure,
} from '@/lib/api/platform-errors'
import { getErrorMessage, requestJson } from '@/components/workspace/settings-client'
import { DraftRequestError, duplicatePosts } from '@/lib/content-drafts/client'
import { SettingsRequestError, settingsErrorMessage, settingsRequest } from '@/lib/settings/client'
import { getDomainTRPCError } from '@/lib/trpc/errors'
import { WorkspaceError } from '@/lib/workspace/errors'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'

function namedError(name: string, message: string, fields: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name }, fields)
}

const trpcStatus: Record<string, number> = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  TOO_MANY_REQUESTS: 429,
  UNAUTHORIZED: 401,
}

test('REST and tRPC resolve every domain error to the same status', () => {
  const zodError = z.object({ a: z.string() }).safeParse({}).error
  const cases: unknown[] = [
    new WorkspaceError('Workspace not found.', 404),
    new WorkspaceError('The workspace changed. Please retry.', 409),
    new BackendSDKError('Session expired.', 401),
    namedError('CampaignError', 'Campaign not found.', { status: 404 }),
    namedError('AnnouncementError', 'Already sent.', { status: 409 }),
    namedError('LaunchError', 'Spec missing.', { status: 400 }),
    namedError('TenantStorageUnavailableError', 'Down.'),
    namedError('InvalidTenantObjectKeyError', 'Bad key.'),
    zodError,
  ]
  for (const error of cases) {
    const failure = toApiFailure(error)
    const trpc = getDomainTRPCError(error)
    assert.ok(failure && trpc, String(error))
    assert.equal(trpcStatus[trpc.code], failure.status, String(error))
    assert.equal(trpc.message, failure.message)
  }
})

test('a 409 carries the conflict code instead of internal_error', () => {
  assert.equal(toApiFailure(new WorkspaceError('Changed.', 409))?.code, 'conflict')
})

test('validation and dependency failures never echo internal details', () => {
  assert.equal(
    toApiFailure(new SyntaxError('Unexpected token < in JSON'))?.message,
    'Invalid request.'
  )
  assert.deepEqual(toApiFailure({ body: { code: 'FAILED_TO_GET_SESSION' } }), {
    ...failureForStatus(503, 'A required dependency is unavailable.'),
  })
  assert.equal(
    toApiFailure(namedError('TenantStorageUnavailableError', 'bucket creds expired'))?.message,
    'A required dependency is unavailable.'
  )
})

test('quota errors use the documented X-RateLimit headers', () => {
  const resetAt = Date.now() + 30_000
  const failure = toApiFailure(
    namedError('WorkspaceQuotaError', 'Over quota.', {
      limit: 5,
      quota: 'api:write:minute',
      resetAt,
      status: 429,
    })
  )
  assert.equal(failure?.code, 'workspace_quota_exceeded')
  assert.deepEqual(failure?.extra, { limit: 5, quota: 'api:write:minute' })
  assert.deepEqual(failure?.headers, rateLimitHeaders(5, resetAt))
  assert.ok(Object.keys(failure?.headers ?? {}).every((name) => !name.startsWith('x-rate')))
})

test('a backend plan gate becomes the entitlement envelope', () => {
  const failure = toApiFailure(
    new BackendSDKError('Upgrade required.', 403, {
      code: 'workspace_feature_not_entitled',
      currentPlan: 'free',
      feature: 'asset:delete',
      requiredPlan: 'pro',
    })
  )
  assert.equal(failure?.code, 'workspace_feature_not_entitled')
  assert.deepEqual(failure?.extra, {
    currentPlan: 'free',
    feature: 'asset:delete',
    requiredPlan: 'pro',
  })
  assert.deepEqual(failure?.headers, { 'x-current-plan': 'free', 'x-required-plan': 'pro' })
})

test('a taken queue slot is a conflict that names the next free slot', () => {
  const failure = toApiFailure(
    new BackendSDKError('The queue slot you reviewed is no longer free.', 409, {
      code: 'queue_slot_taken',
      nextQueueSlot: '2026-11-02T09:00:00Z',
    })
  )
  assert.equal(failure?.status, 409)
  assert.equal(failure?.code, 'conflict')
  assert.deepEqual(failure?.extra, { nextQueueSlot: '2026-11-02T09:00:00Z' })
})

test('a repeat of an account post is a conflict that names the posts it repeats', () => {
  const duplicates = [
    { at: '2026-11-02T09:00:00Z', channelConnectionId: 'c1', postId: 'p1', status: 'PUBLISHED' },
  ]
  const failure = toApiFailure(
    new BackendSDKError('The same text and media is already queued.', 409, {
      code: 'duplicate_content',
      duplicates,
    })
  )
  assert.equal(failure?.status, 409)
  assert.equal(failure?.code, 'conflict')
  assert.deepEqual(failure?.extra, { duplicates })
  // The browser reads the same fields back from the error envelope.
  const error = new DraftRequestError(failure?.message ?? '', 409, { ...failure?.extra })
  assert.deepEqual(duplicatePosts(error), duplicates)
  assert.equal(duplicatePosts(new DraftRequestError('Other conflict.', 409)), null)
})

test('unknown errors are left for the caller to log as a 500', () => {
  assert.equal(toApiFailure(new Error('Unexpected.')), null)
  assert.equal(toApiFailure(namedError('PrismaClientKnownRequestError', 'P2028')), null)
  assert.equal(toApiFailure('not an error'), null)
})

test('a plan refusal is recognized from every browser client, and nothing else is', () => {
  const code = 'workspace_feature_not_entitled'
  const message = 'The workspace:use capability is not available on the current workspace plan.'
  assert.equal(isPlanRefusal(new SettingsRequestError(message, 403, code)), true)
  assert.equal(
    isPlanRefusal(new DraftRequestError(message, 403, { code, requiredPlan: 'pro' })),
    true
  )
  assert.equal(isPlanRefusal({ data: { code: 'FORBIDDEN', platformCode: code } }), true)
  // A role refusal or an outage is not a plan refusal: those keep their own message or retry.
  assert.equal(isPlanRefusal(new SettingsRequestError('Denied.', 403, 'forbidden')), false)
  assert.equal(
    isPlanRefusal(new DraftRequestError('Down.', 503, { code: 'upstream_unavailable' })),
    false
  )
  assert.equal(isPlanRefusal({ data: { code: 'FORBIDDEN', platformCode: 'forbidden' } }), false)
  assert.equal(isPlanRefusal(new Error(message)), false)
  assert.equal(isPlanRefusal(null), false)
})

test('the shared error messages explain a plan refusal from every client, and keep every other message', async () => {
  const body = {
    code: 'workspace_feature_not_entitled',
    error: 'The workspace:use capability is not available on the current workspace plan.',
    message: 'The workspace:use capability is not available on the current workspace plan.',
  }
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json(body, { status: 403 })
  try {
    const refusals = [
      // A tRPC refusal, as the errorFormatter sends it.
      Object.assign(new Error(body.message), { data: { platformCode: body.code } }),
      await settingsRequest('/api/v1/webhooks', z.unknown()).catch((error: unknown) => error),
      await requestJson('/api/workspace/integrations', z.unknown()).catch(
        (error: unknown) => error
      ),
    ]
    for (const refusal of refusals) {
      assert.equal(settingsErrorMessage(refusal), PLAN_REFUSAL_MESSAGE)
      assert.equal(getErrorMessage(refusal), PLAN_REFUSAL_MESSAGE)
    }
  } finally {
    globalThis.fetch = realFetch
  }
  const denied = new SettingsRequestError('Only owners can do that.', 403, 'forbidden')
  assert.equal(settingsErrorMessage(denied), 'Only owners can do that.')
  assert.equal(getErrorMessage(new Error('Offline.')), 'Offline.')
})

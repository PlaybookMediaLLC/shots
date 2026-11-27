import assert from 'node:assert/strict'
import test from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import {
  clearCopilotContextCache,
  completeDocumentText,
  handleDocumentCopilotRequest,
} from '@/lib/ai/document/chat'
import {
  EDITOR_COPILOT_RATE_LIMIT,
  EDITOR_COPILOT_USER_RATE_LIMIT,
} from '@/lib/api/rate-limit-policy'
import type { OrganizationAccess } from '@/lib/auth/access'

function makeAccess(organizationId: string, userId: string): OrganizationAccess {
  return {
    deniedPermissions: [],
    organizationId,
    principal: {
      display: `${userId}@example.com`,
      kind: 'session',
      sessionId: `sess_${userId}`,
      userId,
    },
    requestId: 'req_test_copilot',
    role: 'owner',
  }
}

function stubBackendFetch(options?: {
  failVoiceOnce?: boolean
  onContextFetch?: () => Promise<void>
}) {
  const calls: string[] = []
  let failedOnce = false
  const originalFetch = globalThis.fetch
  const originalBackendUrl = process.env.PUBLISHING_API_URL
  const originalBackendSecret = process.env.PUBLISHING_SERVICE_TOKEN

  process.env.PUBLISHING_API_URL = 'http://backend.local'
  process.env.PUBLISHING_SERVICE_TOKEN = 'test-secret'

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.includes('quota')) {
      return Response.json({ remaining: 1000 })
    }
    if (parsed.pathname.includes('writing-context')) {
      if (options?.onContextFetch) await options.onContextFetch()
      if (options?.failVoiceOnce && !failedOnce) {
        return new Response('not found', { status: 404 })
      }
      return Response.json({
        audience: 'Founders',
        endings: [],
        formatting: '',
        openings: [],
        platformGuidance: '',
        prohibitedPhrases: [],
        samples: [],
        terminology: [],
        tone: 'Direct and concise.',
      })
    }
    if (options?.failVoiceOnce && !failedOnce && parsed.pathname.includes('brand')) {
      failedOnce = true
      return new Response('temporary outage', { status: 500 })
    }
    return Response.json({})
  }) as typeof fetch

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch
      if (originalBackendUrl === undefined) delete process.env.PUBLISHING_API_URL
      else process.env.PUBLISHING_API_URL = originalBackendUrl
      if (originalBackendSecret === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
      else process.env.PUBLISHING_SERVICE_TOKEN = originalBackendSecret
    },
  }
}

test('completeDocumentText sets maxOutputTokens, deduplicates concurrent context loads, and isolates tenant/channel/draft keys', async () => {
  clearCopilotContextCache()
  let releaseContext!: () => void
  let contextGate: Promise<void> | null = new Promise<void>((resolve) => {
    releaseContext = resolve
  })
  const backend = stubBackendFetch({
    onContextFetch: async () => {
      if (contextGate) await contextGate
    },
  })
  const seenCalls: Array<{ abortSignal?: AbortSignal; maxOutputTokens?: number }> = []
  let nextText = ' and measure the result.'

  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seenCalls.push({
        abortSignal: options.abortSignal,
        maxOutputTokens: options.maxOutputTokens,
      })
      if (options.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      return {
        content: [{ text: nextText, type: 'text' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
          outputTokens: { reasoning: 0, text: 5, total: 5 },
        },
        warnings: [],
      }
    },
  })

  try {
    const accessA = makeAccess('org_1', 'user_1')
    const controller = new AbortController()

    const firstPending = completeDocumentText(
      accessA,
      { prompt: 'We shipped faster exports ' },
      { channel: 'x', draftId: 'draft_1' },
      { abortSignal: controller.signal, model }
    )
    const secondPending = completeDocumentText(
      accessA,
      { prompt: 'We shipped faster exports today ' },
      { channel: 'x', draftId: 'draft_1' },
      { model }
    )
    contextGate = null
    releaseContext()
    const [first] = await Promise.all([firstPending, secondPending])

    assert.equal(first.text, 'and measure the result.')
    assert.equal(seenCalls.length, 2)
    assert.ok(seenCalls.every((call) => call.maxOutputTokens === 80))
    assert.ok(seenCalls.some((call) => call.abortSignal === controller.signal))
    assert.equal(
      backend.calls.filter((p) => p.includes('writing-context')).length,
      1,
      'concurrent cold requests must share one in-flight context load'
    )

    const contextCallsAfterWarm = backend.calls.filter((p) => !p.includes('quota')).length

    // Warm request hits TTL cache; whitespace-only completion falls back to '0'.
    nextText = '   '
    const blank = await completeDocumentText(
      accessA,
      { prompt: 'We shipped faster exports now ' },
      { channel: 'x', draftId: 'draft_1' },
      { model }
    )
    assert.equal(blank.text, '0')
    assert.equal(backend.calls.filter((p) => !p.includes('quota')).length, contextCallsAfterWarm)

    // Different user, org, draft, and channel each miss the cache (isolation).
    nextText = ' next.'
    let prev = contextCallsAfterWarm
    for (const [acc, query] of [
      [makeAccess('org_1', 'user_2'), { channel: 'x' as const, draftId: 'draft_1' }],
      [makeAccess('org_2', 'user_1'), { channel: 'x' as const, draftId: 'draft_1' }],
      [accessA, { channel: 'linkedin' as const, draftId: 'draft_1' }],
      [accessA, { channel: 'x' as const, draftId: 'draft_2' }],
    ] as const) {
      await completeDocumentText(acc, { prompt: 'Test ' }, query, { model })
      const now = backend.calls.filter((p) => !p.includes('quota')).length
      assert.ok(now > prev)
      prev = now
    }
  } finally {
    clearCopilotContextCache()
    backend.restore()
  }
})

test('completeDocumentText does not cache rejected context loads and races abort immediately', async () => {
  clearCopilotContextCache()
  let releaseContext!: () => void
  let contextStarted!: () => void
  const contextStartedPromise = new Promise<void>((resolve) => {
    contextStarted = resolve
  })
  const contextGate = new Promise<void>((resolve) => {
    releaseContext = resolve
  })
  let gateActive = false
  const backend = stubBackendFetch({
    failVoiceOnce: true,
    onContextFetch: async () => {
      if (gateActive) {
        contextStarted()
        await contextGate
      }
    },
  })

  let modelCalls = 0
  let hangModel = false
  let markModelStarted = () => {}
  const modelStartedPromise = new Promise<void>((resolve) => {
    markModelStarted = resolve
  })
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      modelCalls += 1
      if (hangModel) {
        markModelStarted()
        await new Promise<void>((resolve, reject) => {
          if (options.abortSignal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'))
            return
          }
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })
      }
      return {
        content: [{ text: 'done.', type: 'text' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }
    },
  })

  try {
    const access = makeAccess('org_abort', 'user_abort')

    // 0. Failed context load rejects and is NOT cached so the retry succeeds.
    await assert.rejects(
      completeDocumentText(
        access,
        { prompt: 'First attempt fails context' },
        { channel: 'x', draftId: 'draft_retry' },
        { model }
      )
    )
    const recovered = await completeDocumentText(
      access,
      { prompt: 'Retry succeeds' },
      { channel: 'x', draftId: 'draft_retry' },
      { model }
    )
    assert.equal(recovered.text, 'done.')
    assert.equal(modelCalls, 1)

    // 1. Pre-aborted with non-Error reason rejects immediately without touching backend or model.
    const preAborted = new AbortController()
    preAborted.abort('client-cancelled')
    const callsBeforePreAbort = backend.calls.length
    await assert.rejects(
      completeDocumentText(
        access,
        { prompt: 'Should not run' },
        { channel: 'x', draftId: 'draft_abort' },
        { abortSignal: preAborted.signal, model }
      ),
      /aborted/i
    )
    assert.equal(backend.calls.length, callsBeforePreAbort)
    assert.equal(modelCalls, 1)

    // 2. Request A aborts BEFORE contextGate releases while peer Request B still succeeds.
    gateActive = true
    const midContext = new AbortController()
    const requestA = completeDocumentText(
      access,
      { prompt: 'Cancel during hung context' },
      { channel: 'x', draftId: 'draft_abort' },
      { abortSignal: midContext.signal, model }
    )
    const requestB = completeDocumentText(
      access,
      { prompt: 'Peer sharing in-flight context' },
      { channel: 'x', draftId: 'draft_abort' },
      { model }
    )
    await contextStartedPromise
    midContext.abort(new DOMException('Cancelled immediately', 'AbortError'))
    await assert.rejects(requestA, /Cancelled immediately/)
    assert.equal(modelCalls, 1)

    gateActive = false
    releaseContext()
    const peerResult = await requestB
    assert.equal(peerResult.text, 'done.')
    assert.equal(modelCalls, 2)

    // 3. Mid-flight abort while model is generating aborts the model call cleanly.
    hangModel = true
    const midModel = new AbortController()
    const midModelPromise = completeDocumentText(
      access,
      { prompt: 'Cancel during generation' },
      { channel: 'x', draftId: 'draft_abort' },
      { abortSignal: midModel.signal, model }
    )
    await modelStartedPromise
    midModel.abort(new DOMException('Cancelled during model', 'AbortError'))
    await assert.rejects(midModelPromise, /Abort|Cancelled/)
    assert.equal(modelCalls, 3)
  } finally {
    clearCopilotContextCache()
    backend.restore()
  }
})

test('handleDocumentCopilotRequest returns 499 on aborts and isolates per-user rate limit from workspace cap', async () => {
  const counts = new Map<string, number>()
  const checkRateLimit = async (identifier: string, policy: { maxRequests: number }) => {
    const next = (counts.get(identifier) ?? 0) + 1
    counts.set(identifier, next)
    return { allowed: next <= policy.maxRequests }
  }

  const user1 = makeAccess('org_rl', 'user_1')
  const user2 = makeAccess('org_rl', 'user_2')
  const baseDeps = {
    checkRateLimit,
    complete: async () => ({ text: 'continuation.' }),
    isAiEnabled: async () => true,
    isConfigured: () => true,
  }

  // 1. Pre-aborted signal returns 499 before touching rate limits or completion.
  const preAborted = new AbortController()
  preAborted.abort()
  const preRes = await handleDocumentCopilotRequest(
    { access: user1, body: { prompt: 'hi ' }, query: {}, signal: preAborted.signal },
    baseDeps
  )
  assert.ok(preRes instanceof Response)
  assert.equal(preRes.status, 499)
  assert.equal(counts.size, 0)

  // 2. Unconfigured AI returns 503 and disabled workspace AI returns 403.
  const unconfigured = await handleDocumentCopilotRequest(
    { access: user1, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
    { ...baseDeps, isConfigured: () => false }
  )
  assert.ok(unconfigured instanceof Response)
  assert.equal(unconfigured.status, 503)

  const disabled = await handleDocumentCopilotRequest(
    { access: user1, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
    { ...baseDeps, isAiEnabled: async () => false }
  )
  assert.ok(disabled instanceof Response)
  assert.equal(disabled.status, 403)

  // 3. Mid-flight abort inside complete() returns 499; non-abort errors rethrow.
  const midAborted = new AbortController()
  const midRes = await handleDocumentCopilotRequest(
    { access: user1, body: { prompt: 'hi ' }, query: {}, signal: midAborted.signal },
    {
      ...baseDeps,
      complete: async (_access, _body, _query, opts) => {
        midAborted.abort(new DOMException('client gone', 'AbortError'))
        assert.equal(opts?.abortSignal, midAborted.signal)
        throw new DOMException('client gone', 'AbortError')
      },
    }
  )
  assert.ok(midRes instanceof Response)
  assert.equal(midRes.status, 499)

  await assert.rejects(
    handleDocumentCopilotRequest(
      { access: user1, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
      {
        ...baseDeps,
        complete: async () => {
          throw new Error('provider failure')
        },
      }
    ),
    /provider failure/
  )

  // 4. Exhausting user1's per-user cap returns 429 WITHOUT incrementing the workspace cap.
  counts.clear()
  const user1Key = `editor-copilot-user:${user1.organizationId}:${user1.principal.userId}`
  const workspaceKey = `editor-copilot:${user1.organizationId}`
  counts.set(user1Key, EDITOR_COPILOT_USER_RATE_LIMIT.maxRequests)

  const throttled = await handleDocumentCopilotRequest(
    { access: user1, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
    baseDeps
  )
  assert.ok(throttled instanceof Response)
  assert.equal(throttled.status, 429)
  assert.equal(
    counts.get(workspaceKey) ?? 0,
    0,
    'throttled user must not increment the shared workspace budget'
  )

  // Peer user2 in the same workspace still succeeds.
  const peerOk = await handleDocumentCopilotRequest(
    { access: user2, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
    baseDeps
  )
  assert.deepEqual(peerOk, { text: 'continuation.' })

  // 5. Exhausted workspace cap returns 429 even for a fresh user.
  counts.set(workspaceKey, EDITOR_COPILOT_RATE_LIMIT.maxRequests)
  const wsThrottled = await handleDocumentCopilotRequest(
    { access: user2, body: { prompt: 'hi ' }, query: {}, signal: new AbortController().signal },
    baseDeps
  )
  assert.ok(wsThrottled instanceof Response)
  assert.equal(wsThrottled.status, 429)
})

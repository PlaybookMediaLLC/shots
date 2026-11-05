import assert from 'node:assert/strict'
import test from 'node:test'
import type { BackendAuditEvent, BackendLaunchRunStepInput } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import {
  createToolRun,
  defineTool,
  flushToolRun,
  isRunStopped,
  type ToolRun,
  type ToolSpec,
} from '@/lib/ai/tools/executor'
import type { OrganizationRole } from '@/lib/auth/permissions'

/** A run whose audit events land in `events` and trace steps in `steps`. */
function fakeRun(
  role: OrganizationRole,
  options: {
    audit?: () => Promise<unknown>
    deniedPermissions?: readonly string[]
    launchRunId?: string
    recordStep?: () => Promise<unknown>
    signal?: AbortSignal
  } = {}
) {
  const events: BackendAuditEvent[] = []
  const steps: BackendLaunchRunStepInput[] = []
  const run = createToolRun({
    access: {
      deniedPermissions: options.deniedPermissions ?? [],
      organizationId: 'org_1',
      principal: { display: 'ada@example.com', kind: 'session', sessionId: 's_1', userId: 'u_1' },
      requestId: 'req_1',
      role,
    },
    audit:
      options.audit ??
      (async (event) => {
        events.push(event)
      }),
    launchRunId: options.launchRunId,
    recordStep:
      options.recordStep ??
      (async (step) => {
        steps.push(step)
      }),
    signal: options.signal,
  })
  return { events, run, steps }
}

function spec(
  overrides: Partial<ToolSpec<{ value: number }, { ok: true; value: number }>> = {}
): ToolSpec<{ value: number }, { ok: true; value: number }> {
  return {
    description: 'Echo a value.',
    effect: 'draft',
    execute: ({ value }) => ({ ok: true, value }),
    inputSchema: z.object({ value: z.number() }),
    maxCallsPerRun: 10,
    name: 'echo',
    permission: 'release:create',
    timeoutMs: 1_000,
    ...overrides,
  }
}

function call(run: ToolRun, toolSpec: ReturnType<typeof spec>, input: Record<string, unknown>) {
  return defineTool(run, toolSpec).execute(input as { value: number }, {
    context: undefined as never,
    messages: [],
    toolCallId: 'call_1',
  })
}

test('a viewer is denied a tool that needs release:create, and the denial is audited', async () => {
  const { events, run } = fakeRun('viewer')
  let ran = false
  const result = await call(
    run,
    spec({
      execute: () => {
        ran = true
        return { ok: true, value: 1 }
      },
    }),
    { value: 1 }
  )
  assert.equal(ran, false)
  assert.deepEqual(result, {
    code: 'DENIED',
    error: 'This run is not allowed to call echo.',
    ok: false,
  })
  await flushToolRun(run)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.outcome, 'DENIED')
  assert.equal(events[0]!.metadata?.errorCode, 'DENIED')
})

test('a permission group stops a tool the role would allow', async () => {
  const { run } = fakeRun('owner', { deniedPermissions: ['release:create'] })
  let ran = false
  const result = await call(
    run,
    spec({
      execute: () => {
        ran = true
        return { ok: true, value: 1 }
      },
    }),
    { value: 1 }
  )
  assert.equal(ran, false)
  assert.deepEqual(result, {
    code: 'DENIED',
    error: 'This run is not allowed to call echo.',
    ok: false,
  })
})

test('a viewer may still call read tools', async () => {
  const { run } = fakeRun('viewer')
  const result = await call(run, spec({ effect: 'read', permission: 'workspace:read' }), {
    value: 2,
  })
  assert.deepEqual(result, { ok: true, value: 2 })
})

test('a tool past its per-run cap returns an error naming the cap', async () => {
  const { run } = fakeRun('creator')
  const capped = spec({ maxCallsPerRun: 1 })
  assert.deepEqual(await call(run, capped, { value: 1 }), { ok: true, value: 1 })
  assert.deepEqual(await call(run, capped, { value: 2 }), {
    code: 'CALL_LIMIT',
    error: 'At most 1 echo calls per run.',
    ok: false,
  })
})

test('tools with the same budget share one cap', async () => {
  const { run } = fakeRun('creator')
  const create = spec({ budget: 'designs', maxCallsPerRun: 1, name: 'create' })
  const edit = spec({ budget: 'designs', maxCallsPerRun: 1, name: 'edit' })
  assert.deepEqual(await call(run, create, { value: 1 }), { ok: true, value: 1 })
  assert.deepEqual(await call(run, edit, { value: 2 }), {
    code: 'CALL_LIMIT',
    error: 'At most 1 designs calls per run.',
    ok: false,
  })
})

test('three identical consecutive calls stop the run, whatever the key order', async () => {
  const { run } = fakeRun('creator')
  const loop = spec()
  const stop = isRunStopped(run)
  assert.equal((await call(run, loop, { a: 1, value: 1 }))?.ok, true)
  assert.equal((await call(run, loop, { value: 1, a: 1 }))?.ok, true)
  assert.equal(await stop({ steps: [] }), false)
  const third = await call(run, loop, { a: 1, value: 1 })
  assert.equal(third && !third.ok && third.code, 'LOOP_DETECTED')
  assert.equal(await stop({ steps: [] }), true)
})

test('a different call in between resets the loop count', async () => {
  const { run } = fakeRun('creator')
  const loop = spec()
  await call(run, loop, { value: 1 })
  await call(run, loop, { value: 1 })
  await call(run, loop, { value: 2 })
  assert.equal((await call(run, loop, { value: 1 }))?.ok, true)
  assert.equal(run.stopReason, null)
})

test('a call that outlives its timeout returns TIMEOUT and the run continues', async () => {
  const { run } = fakeRun('creator')
  const slow = spec({ execute: () => new Promise(() => undefined), timeoutMs: 20 })
  const result = await call(run, slow, { value: 1 })
  assert.equal(result && !result.ok && result.code, 'TIMEOUT')
  assert.equal(run.stopReason, null)
})

test('a cancelled run refuses calls', async () => {
  const controller = new AbortController()
  controller.abort()
  const { run } = fakeRun('creator', { signal: controller.signal })
  const result = await call(run, spec(), { value: 1 })
  assert.equal(result && !result.ok && result.code, 'CANCELLED')
})

test('a throwing tool comes back as a FAILED result, not a throw', async () => {
  const { events, run } = fakeRun('creator')
  const result = await call(
    run,
    spec({
      execute: () => {
        throw new Error('secret backend detail')
      },
    }),
    { value: 1 }
  )
  assert.deepEqual(result, {
    code: 'FAILED',
    error: 'echo failed. Try another approach.',
    ok: false,
  })
  await flushToolRun(run)
  assert.equal(events[0]!.outcome, 'FAILED')
  assert.ok(!JSON.stringify(events).includes('secret'))
})

test('a tool that returns its own failure is audited as REJECTED', async () => {
  const { events, run } = fakeRun('creator')
  const rejecting = spec({
    execute: () => ({ error: 'Unknown id.', ok: false }) as unknown as { ok: true; value: number },
  })
  assert.deepEqual(await call(run, rejecting, { value: 1 }), { error: 'Unknown id.', ok: false })
  await flushToolRun(run)
  assert.equal(events[0]!.outcome, 'FAILED')
  assert.equal(events[0]!.metadata?.errorCode, 'REJECTED')
})

test('each call appends one audit event with the run, outcome, and no inputs', async () => {
  const { events, run } = fakeRun('creator', { launchRunId: 'run_42' })
  await call(run, spec(), { value: 7 })
  await flushToolRun(run)
  assert.equal(events.length, 1)
  const [event] = events
  assert.equal(typeof event!.metadata?.durationMs, 'number')
  assert.deepEqual(
    { ...event, metadata: { ...event!.metadata, durationMs: 0 } },
    {
      action: 'product.agent_tool_called',
      entityId: 'run_42',
      entityType: 'launch_run',
      metadata: { durationMs: 0, effect: 'draft', errorCode: null, tool: 'echo' },
      outcome: 'SUCCEEDED',
    }
  )
})

test('a run without a launch run is audited as an agent run with its own id', async () => {
  const { events, run } = fakeRun('creator')
  await call(run, spec(), { value: 1 })
  await flushToolRun(run)
  assert.equal(events[0]!.entityType, 'agent_run')
  assert.match(String(events[0]!.entityId), /^[0-9a-f-]{36}$/)
})

test('a failing audit write never fails the tool', async () => {
  const errors = console.error
  console.error = () => undefined
  try {
    const { run } = fakeRun('creator', { audit: () => Promise.reject(new Error('down')) })
    assert.deepEqual(await call(run, spec(), { value: 3 }), { ok: true, value: 3 })
    await flushToolRun(run)
  } finally {
    console.error = errors
  }
})

test('every call, refused or not, appends one tool step with the next index', async () => {
  const { run, steps } = fakeRun('creator', { launchRunId: 'run_42' })
  const capped = spec({ maxCallsPerRun: 1 })
  await call(run, capped, { value: 1 })
  await call(run, capped, { value: 2 })
  await call(run, spec({ effect: 'external', name: 'fetch', permission: 'release:approve' }), {
    value: 3,
  })
  await flushToolRun(run)
  assert.deepEqual(
    steps.map((step) => ({ ...step, durationMs: 0 })),
    [
      {
        durationMs: 0,
        effect: 'write',
        errorCode: null,
        index: 0,
        inputSummary: { value: 1 },
        kind: 'tool',
        outputSummary: { ok: true, value: 1 },
        status: 'SUCCEEDED',
        toolName: 'echo',
      },
      {
        durationMs: 0,
        effect: 'write',
        errorCode: 'call_limit',
        index: 1,
        inputSummary: { value: 2 },
        kind: 'tool',
        outputSummary: { code: 'CALL_LIMIT', error: 'At most 1 echo calls per run.', ok: false },
        status: 'FAILED',
        toolName: 'echo',
      },
      {
        durationMs: 0,
        effect: 'external',
        errorCode: 'denied',
        index: 2,
        inputSummary: { value: 3 },
        kind: 'tool',
        outputSummary: {
          code: 'DENIED',
          error: 'This run is not allowed to call fetch.',
          ok: false,
        },
        status: 'DENIED',
        toolName: 'fetch',
      },
    ]
  )
  assert.equal(run.stepIndex, 3)
})

test('step summaries redact credentials, omit binary, and stay small', async () => {
  const { run, steps } = fakeRun('creator')
  const image = 'A'.repeat(40_000)
  const noisy = spec({
    execute: () =>
      ({
        nested: { deep: true },
        ok: true,
        previewJpegBase64: image,
        rendered: new Uint8Array(8),
        urls: ['https://a.example', 'https://b.example'],
      }) as unknown as { ok: true; value: number },
  })
  await call(run, noisy, {
    accessToken: 'secret-token',
    logo: `data:image/png;base64,${image}`,
    note: 'word '.repeat(1_000),
    value: 1,
  })
  await flushToolRun(run)
  const [step] = steps
  assert.deepEqual(step!.inputSummary, {
    accessToken: '[REDACTED]',
    logo: `[${image.length + 22} characters omitted]`,
    note: `${'word '.repeat(40)}…`,
    value: 1,
  })
  assert.deepEqual(step!.outputSummary, {
    nested: '[object]',
    ok: true,
    previewJpegBase64: '[40000 characters omitted]',
    rendered: '[binary omitted]',
    urls: '[2 items]',
  })
  const json = JSON.stringify(step)
  assert.ok(!json.includes('AAAA') && !json.includes('secret-token'))
  assert.ok(Buffer.byteLength(json) < 16 << 10)
})

test('a failing step write never fails the tool', async () => {
  const errors = console.error
  console.error = () => undefined
  try {
    const { run } = fakeRun('creator', { recordStep: () => Promise.reject(new Error('down')) })
    assert.deepEqual(await call(run, spec(), { value: 3 }), { ok: true, value: 3 })
    await flushToolRun(run)
    assert.equal(run.pending.size, 0)
  } finally {
    console.error = errors
  }
})

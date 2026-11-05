import { randomUUID } from 'node:crypto'
import {
  type FlexibleSchema,
  type StopCondition,
  type Tool,
  type ToolExecutionOptions,
  type ToolResultPart,
  type ToolSet,
} from 'ai'
import type {
  BackendAuditEvent,
  BackendLaunchRunStepInput,
  BackendToolEffect,
} from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import type { OrganizationAccess } from '@/lib/auth/access'
import { type AuditMetadata, sanitizeAuditMetadata } from '@/lib/audit/metadata'
import { accessAllows, type Permission } from '@/lib/auth/permissions'

/**
 * The agent tool executor (RFC 027).
 *
 * Every agent tool is declared with a capability record: what it does to the
 * workspace, the permission it needs, how often a run may call it, and how
 * long one call may take. The executor enforces each field on every call,
 * returns failures to the model as results rather than throws, audits
 * each call, and, given a step sink, records each call as a trace step.
 * Pure: the sinks are passed in, so it runs in tests.
 */

/** What a tool does to the workspace. */
export const toolEffectSchema = z.enum(['read', 'draft', 'mutate', 'external'])
/** What a tool does to the workspace. */
export type ToolEffect = z.infer<typeof toolEffectSchema>

/** Stable codes for a tool call that did not succeed. */
export const toolErrorCodeSchema = z.enum([
  /** The run's role lacks the tool's permission. */
  'DENIED',
  /** The tool reached its per-run call cap. */
  'CALL_LIMIT',
  /** The same call was made three times in a row; the run stops. */
  'LOOP_DETECTED',
  /** The call took longer than the tool's timeout. */
  'TIMEOUT',
  /** The run was cancelled. */
  'CANCELLED',
  /** The tool threw. */
  'FAILED',
  /** The tool ran and returned its own failure. */
  'REJECTED',
])
/** Stable codes for a tool call that did not succeed. */
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>

/** A failed tool call, returned to the model as data so it can adjust. */
export type ToolFailure = { code?: ToolErrorCode; error: string; ok: false }

/** The audit entity a run's tool calls are recorded against. */
export const toolRunEntitySchema = z.enum(['launch_run', 'agent_run'])
/** The audit entity a run's tool calls are recorded against. */
export type ToolRunEntity = z.infer<typeof toolRunEntitySchema>

/** Identical consecutive calls that end a run. */
export const LOOP_LIMIT = 3

/** One agent run's tool state: who is calling, counters, and the stop flag. */
export type ToolRun = {
  /** The principal that started the run; tools act as it, with its role. */
  readonly access: OrganizationAccess
  readonly audit: (event: BackendAuditEvent) => Promise<unknown>
  /** Calls made per tool name. */
  readonly counts: Map<string, number>
  readonly entityType: ToolRunEntity
  /** The previous call's name and input, and how many times in a row it was made. */
  last: { key: string; repeats: number } | null
  /** Audit and step writes still in flight; {@link flushToolRun} waits for them. */
  readonly pending: Set<Promise<unknown>>
  /** Appends one trace step; absent when the run keeps no trace. */
  readonly recordStep?: (step: BackendLaunchRunStepInput) => Promise<unknown>
  readonly runId: string
  readonly signal?: AbortSignal
  /**
   * The next trace step's index, from 0. A caller that records its own steps
   * on the same run (model steps) takes indexes from here too.
   */
  stepIndex: number
  /** Set when the run must stop; {@link isRunStopped} ends the model loop. */
  stopReason: ToolErrorCode | null
}

/**
 * Start a run's tool state. Pass the launch run's id when there is one;
 * otherwise the run gets its own id and is audited as an agent run.
 */
export function createToolRun(input: {
  access: OrganizationAccess
  /** Writes one audit event; failures are swallowed. */
  audit: (event: BackendAuditEvent) => Promise<unknown>
  launchRunId?: string
  /** Appends one trace step per tool call; failures are swallowed. */
  recordStep?: (step: BackendLaunchRunStepInput) => Promise<unknown>
  signal?: AbortSignal
}): ToolRun {
  return {
    access: input.access,
    audit: input.audit,
    counts: new Map(),
    entityType: input.launchRunId ? 'launch_run' : 'agent_run',
    last: null,
    pending: new Set(),
    recordStep: input.recordStep,
    runId: input.launchRunId ?? randomUUID(),
    signal: input.signal,
    stepIndex: 0,
    stopReason: null,
  }
}

/** A stop condition, used next to `stepCountIs`, that ends the loop once the run stops. */
export function isRunStopped<TOOLS extends ToolSet>(run: ToolRun): StopCondition<TOOLS> {
  return () => run.stopReason !== null
}

/** Waits for the run's audit and step writes. Call when the run ends. */
export async function flushToolRun(run: ToolRun): Promise<void> {
  await Promise.allSettled([...run.pending])
}

/** A tool's capability record and implementation. */
export type ToolSpec<INPUT, OUTPUT> = {
  /** Model-facing and behavioral; no data. */
  description: string
  effect: ToolEffect
  /** Receives a signal that aborts on timeout or cancellation. */
  execute: (input: INPUT, context: { signal: AbortSignal }) => Promise<OUTPUT> | OUTPUT
  inputSchema: FlexibleSchema<INPUT>
  maxCallsPerRun: number
  name: string
  /** Tools with the same budget share one `maxCallsPerRun` counter; defaults to the name. */
  budget?: string
  permission: Permission
  timeoutMs: number
  /** Shapes the result for the model, e.g. an image instead of base64 JSON. */
  toModelOutput?: (options: {
    input: INPUT
    output: NoInfer<OUTPUT> | ToolFailure
    toolCallId: string
  }) => ToolResultPart['output'] | PromiseLike<ToolResultPart['output']>
}

/** The AI SDK tool {@link defineTool} returns; `execute` always resolves to a result. */
export type DefinedTool<INPUT, OUTPUT> = {
  execute: (
    input: INPUT,
    options: ToolExecutionOptions<Record<string, unknown>>
  ) => Promise<OUTPUT | ToolFailure>
} & Tool<INPUT, OUTPUT | ToolFailure>

/** Capability records without implementations, for tools that run elsewhere. */
export type ToolCapability = Pick<
  ToolSpec<unknown, unknown>,
  'effect' | 'maxCallsPerRun' | 'permission'
>

/** JSON with object keys sorted, so equal inputs compare equal. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, (entry as Record<string, unknown>)[key]])
        )
      : entry
  )
}

function fail(code: ToolErrorCode, error: string): ToolFailure {
  return { code, error, ok: false }
}

function isFailure(value: unknown): value is ToolFailure {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false)
}

/** Runs `execute` until it settles or `signal` aborts, whichever comes first. */
function withSignal<T>(signal: AbortSignal, execute: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    Promise.resolve().then(execute).then(resolve, reject)
  })
}

/** The trace effect for each executor effect; the trace has no draft or mutate. */
const STEP_EFFECTS: Record<ToolEffect, BackendToolEffect> = {
  draft: 'write',
  external: 'external',
  mutate: 'write',
  read: 'read',
}

/** Longest string a step summary keeps. */
const SUMMARY_STRING_MAX = 200
/** Most fields a step summary keeps. */
const SUMMARY_FIELDS_MAX = 24
/** Far under the backend's 16 KiB cap per summary. */
const SUMMARY_BYTES_MAX = 8 << 10
/** A data URL, or a long unbroken run of base64: image or file bytes. */
const binaryText = /^data:|^[A-Za-z0-9+/_-]{80,}={0,2}$/

function summaryField(value: unknown): AuditMetadata[string] {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (binaryText.test(value)) return `[${value.length} characters omitted]`
    return value.length > SUMMARY_STRING_MAX ? `${value.slice(0, SUMMARY_STRING_MAX)}…` : value
  }
  if (Array.isArray(value)) return `[${value.length} items]`
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary omitted]'
  return value && typeof value === 'object' ? '[object]' : null
}

/**
 * A tool input or output as a trace summary: top-level fields only, nested
 * values described, strings cut short, binary omitted, credential-like keys
 * redacted, and the whole capped.
 */
function summarize(value: unknown): AuditMetadata {
  const fields: Array<[string, unknown]> =
    value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)
      ? Object.entries(value).slice(0, SUMMARY_FIELDS_MAX)
      : [['value', value]]
  const summary = sanitizeAuditMetadata(
    Object.fromEntries(fields.map(([key, entry]) => [key.slice(0, 64), summaryField(entry)]))
  )
  return Buffer.byteLength(JSON.stringify(summary)) > SUMMARY_BYTES_MAX
    ? { omitted: 'too large' }
    : summary
}

/** Runs a fire-and-forget write; {@link flushToolRun} waits for it and it never throws. */
function track(run: ToolRun, tool: string, what: string, write: () => Promise<unknown>) {
  const pending = Promise.resolve()
    .then(write)
    .catch((error: unknown) => {
      console.error(`Agent tool ${what} failed.`, {
        reason: error instanceof Error ? error.message : 'unknown',
        tool,
      })
    })
  run.pending.add(pending)
  void pending.finally(() => run.pending.delete(pending))
}

/** Audits one call and, when the run keeps a trace, appends its step. */
function record(
  run: ToolRun,
  spec: Pick<ToolSpec<unknown, unknown>, 'effect' | 'name'>,
  started: number,
  input: unknown,
  result: unknown
) {
  const code = isFailure(result) ? (result.code ?? 'REJECTED') : null
  const status = code === 'DENIED' ? 'DENIED' : code ? 'FAILED' : 'SUCCEEDED'
  const durationMs = Date.now() - started
  // ponytail: one write per call, not batched; the SDK has no batch append.
  track(run, spec.name, 'audit', () =>
    run.audit({
      action: 'product.agent_tool_called',
      entityId: run.runId,
      entityType: run.entityType,
      // Never inputs or outputs: they can carry customer content.
      metadata: sanitizeAuditMetadata({
        durationMs,
        effect: spec.effect,
        errorCode: code,
        tool: spec.name,
      }),
      outcome: status,
    })
  )
  const { recordStep } = run
  if (!recordStep) return
  const step: BackendLaunchRunStepInput = {
    durationMs,
    effect: STEP_EFFECTS[spec.effect],
    // The backend takes lowercase codes.
    errorCode: code?.toLowerCase() ?? null,
    index: run.stepIndex++,
    inputSummary: summarize(input),
    kind: 'tool',
    outputSummary: summarize(result),
    status,
    toolName: spec.name,
  }
  track(run, spec.name, 'step', () => recordStep(step))
}

async function call<INPUT, OUTPUT>(
  run: ToolRun,
  spec: ToolSpec<INPUT, OUTPUT>,
  input: INPUT,
  abortSignal: AbortSignal | undefined
): Promise<OUTPUT | ToolFailure> {
  const signals = [run.signal, abortSignal].filter((entry): entry is AbortSignal => Boolean(entry))
  if (signals.some((signal) => signal.aborted)) {
    return fail('CANCELLED', 'The run was cancelled.')
  }
  const key = `${spec.name}:${stableJson(input)}`
  const repeats = run.last?.key === key ? run.last.repeats + 1 : 1
  run.last = { key, repeats }
  if (repeats >= LOOP_LIMIT) {
    run.stopReason = 'LOOP_DETECTED'
    return fail('LOOP_DETECTED', `${spec.name} was called with the same input ${repeats} times.`)
  }
  if (!accessAllows(run.access, spec.permission)) {
    return fail('DENIED', `This run is not allowed to call ${spec.name}.`)
  }
  const budget = spec.budget ?? spec.name
  const count = run.counts.get(budget) ?? 0
  if (count >= spec.maxCallsPerRun) {
    return fail('CALL_LIMIT', `At most ${spec.maxCallsPerRun} ${budget} calls per run.`)
  }
  run.counts.set(budget, count + 1)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), spec.timeoutMs)
  const signal = AbortSignal.any([...signals, timeout.signal])
  try {
    // ponytail: a timed-out call is abandoned, not killed; tools that honor `signal` stop early.
    return await withSignal(signal, () => spec.execute(input, { signal }))
  } catch (error) {
    if (timeout.signal.aborted) {
      return fail('TIMEOUT', `${spec.name} took longer than ${spec.timeoutMs / 1000}s.`)
    }
    if (signal.aborted) return fail('CANCELLED', 'The run was cancelled.')
    console.error('Agent tool failed.', {
      reason: error instanceof Error ? error.message : 'unknown',
      tool: spec.name,
    })
    return fail('FAILED', `${spec.name} failed. Try another approach.`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Declare an agent tool for one run. The returned AI SDK tool checks the
 * run's role against `permission`, enforces `maxCallsPerRun`, the loop
 * limit, and `timeoutMs`, returns every failure as a {@link ToolFailure},
 * and appends one `product.agent_tool_called` audit event per call, plus one
 * trace step when the run has `recordStep`.
 */
export function defineTool<INPUT, OUTPUT>(
  run: ToolRun,
  spec: ToolSpec<INPUT, OUTPUT>
): DefinedTool<INPUT, OUTPUT> {
  const execute: DefinedTool<INPUT, OUTPUT>['execute'] = async (input, options) => {
    const started = Date.now()
    const result = await call(run, spec, input, options.abortSignal)
    record(run, spec, started, input, result)
    return result
  }
  // What `tool()` builds; its inference cannot see through a generic wrapper, so it is asserted.
  return {
    description: spec.description,
    execute,
    inputSchema: spec.inputSchema,
    ...(spec.toModelOutput ? { toModelOutput: spec.toModelOutput } : {}),
  } as unknown as DefinedTool<INPUT, OUTPUT>
}

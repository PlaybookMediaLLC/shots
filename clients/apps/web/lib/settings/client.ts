'use client'

import { z } from 'zod'
import {
  qualificationErrorDetailsSchema,
  kitReadinessErrorDetailsSchema,
  sourceSelectionErrorDetailsSchema,
} from 'screenshot-studio-backend-sdk'
import { debugLog, redactPath } from '@/lib/debug-log'
import { isPlanRefusal, PLAN_REFUSAL_MESSAGE } from '@/lib/api/platform-errors'
import { workspaceScopeHeaders, type WorkspaceRequestScope } from '@/lib/auth/request-scope'

const releaseErrorDetailsSchema = z.union([
  kitReadinessErrorDetailsSchema,
  qualificationErrorDetailsSchema,
  sourceSelectionErrorDetailsSchema,
])

/** A settings request the server refused, with its status and error code. */
export class SettingsRequestError extends Error {
  /** The HTTP status. */
  readonly status: number
  /** The platform error code, such as `conflict`. */
  readonly code: string | null

  /** A refusal with its message, status and code. */
  constructor(
    message: string,
    status: number,
    code: string | null,
    readonly details?: z.infer<typeof releaseErrorDetailsSchema>
  ) {
    super(message)
    this.name = 'SettingsRequestError'
    this.status = status
    this.code = code
  }
}

const failureSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  details: releaseErrorDetailsSchema.optional(),
})

/**
 * Calls a settings route and parses its answer with the contract's schema, so
 * a value the server did not send never reaches the UI.
 */
export async function settingsRequest<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  options: {
    body?: unknown
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
    scope?: WorkspaceRequestScope
    signal?: AbortSignal
    commandKey?: string
  } = {}
): Promise<z.output<Schema>> {
  const method = options.method ?? 'GET'
  const started = performance.now()
  const response = await fetch(path, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.scope ? workspaceScopeHeaders(options.scope) : {}),
      ...(options.commandKey ? { 'Idempotency-Key': options.commandKey } : {}),
    },
    method,
    signal: options.signal,
  })
  debugLog('request', `${method} ${redactPath(path)} ${response.status}`, {
    durationMs: Math.round(performance.now() - started),
    requestId: response.headers.get('x-request-id'),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const failure = failureSchema.safeParse(payload)
    throw new SettingsRequestError(
      failure.data?.message ?? failure.data?.error ?? 'The request could not be completed.',
      response.status,
      failure.data?.code ?? null,
      failure.data?.details
    )
  }
  return schema.parse(payload)
}

/** A person-readable message for any failure; a plan refusal says so instead of naming the API's gate. */
export function settingsErrorMessage(error: unknown): string {
  if (isPlanRefusal(error)) return PLAN_REFUSAL_MESSAGE
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { bodyFormatSchema, httpSuccessStatusSchema, noInputSchema } from '@/lib/api/contract'
import type { RouteContract } from '@/lib/api/contract'
import {
  type ApiFailure,
  failureForStatus,
  type HttpErrorStatus,
  toApiFailure,
  toErrorBody,
} from '@/lib/api/platform-errors'
import { getRequestId, platformHeaders } from '@/lib/api/request-context'
import { withRequestReads } from '@/lib/auth/request-reads'
import { isCrossOriginCookieMutation } from '@/lib/security/request-origin'
import { readBoundedText } from '@/lib/security/request-body'

/**
 * `route()` runs every platform API request through one fixed pipeline:
 *
 *   request id → shell guard → auth → params/query/body parse → handler
 *   → output parse → response headers → one log line
 *
 * It imports nothing server-only; authenticators that reach the session store
 * live in `lib/api/route-auth.ts`.
 */

/** Awaited path parameters of a dynamic route segment. */
export const routeParamsSchema = z.record(z.string(), z.string())

/** One of {@link routeParamsSchema}. */
export type RouteParams = z.infer<typeof routeParamsSchema>

/** The unvalidated request, read once on demand. */
export const rawRequestSchema = z.object({
  /** Parsed JSON, the raw text, or `undefined` when the contract takes no body. */
  body: z.unknown(),
  /** Request headers keyed by lowercase name. */
  headers: z.record(z.string(), z.string()),
  params: routeParamsSchema,
  query: z.record(z.string(), z.string()),
})

/** One of {@link rawRequestSchema}. */
export type RawRequest = z.infer<typeof rawRequestSchema>

/** What an authenticator can read. */
export const authenticateContextSchema = z.object({
  /** Read the raw request. Reading consumes the body, so only call it when a value is needed. */
  raw: z.function({ input: [], output: z.promise(rawRequestSchema) }),
  request: z.instanceof(NextRequest),
})

/** The function schema of an authenticator that resolves the caller as `access`. */
export function authenticatorSchema<Access extends z.ZodType>(access: Access) {
  return z.function({ input: [authenticateContextSchema], output: z.promise(access) })
}

/** Resolves the caller as `Access`, or throws an `AuthorizationError`. */
export type Authenticate<Access> = z.input<
  ReturnType<typeof authenticatorSchema<z.ZodType<Access, Access>>>
>

/** The schema of what a handler receives for `contract`, with the caller resolved as `access`. */
export function routeHandlerContextSchema<C extends RouteContract, Access extends z.ZodType>(
  contract: C,
  access: Access
) {
  return z.object({
    access,
    body: contract.body as C['body'],
    headers: contract.headers as C['headers'],
    params: contract.params as C['params'],
    query: contract.query as C['query'],
    request: z.instanceof(NextRequest),
    requestId: z.string(),
  })
}

/** The schema of a route binding: its authenticator, handler, and optional status picker. */
export function routeBindingSchema<C extends RouteContract, Access extends z.ZodType>(
  contract: C,
  access: Access
) {
  return z.object({
    auth: authenticatorSchema(access),
    /** Returns the output (checked against `contract.output`) or a ready `Response`. */
    handler: z.function({
      input: [routeHandlerContextSchema(contract, access)],
      output: z.promise(z.union([contract.output as C['output'], z.instanceof(Response)])),
    }),
    /** Picks the success status from the parsed output when there is more than one. */
    status: z
      .function({ input: [contract.output as C['output']], output: httpSuccessStatusSchema })
      .optional(),
  })
}

/** How a route file binds a contract to its authenticator and handler. */
export type RouteBinding<C extends RouteContract, Access> = z.input<
  ReturnType<typeof routeBindingSchema<C, z.ZodType<Access, Access>>>
>

/** The Next.js route handler `route()` returns. */
export const routeExportSchema = z.function({
  input: [z.instanceof(NextRequest), z.object({ params: z.promise(routeParamsSchema) })],
  output: z.promise(z.instanceof(Response)),
})

/** One of {@link routeExportSchema}. */
export type RouteExport = z.input<typeof routeExportSchema>

/** Calling shells recognized in the `x-playbook-client` header; anything else is `unknown`. */
export const shellClientSchema = z.enum(['cli', 'openwhispr', 'wanta', 'web', 'unknown'])

/** The per-request log event. Shell routes keep the event the log pipeline already counts. */
export const routeLogEventSchema = z.enum(['playbook.api_request', 'playbook.shell_request'])

/** The one structured log line written per request. No emails, IPs, bodies, or secrets. */
export const routeLogEntrySchema = z.object({
  client: shellClientSchema,
  durationMs: z.int().nonnegative(),
  event: routeLogEventSchema,
  method: z.string(),
  organizationId: z.string().optional(),
  /** The principal kind only, such as `session` or `organization_api_key`. */
  principal: z.string().optional(),
  requestId: z.string(),
  route: z.string(),
  status: z.int(),
})

/** One of {@link routeLogEntrySchema}. */
export type RouteLogEntry = z.infer<typeof routeLogEntrySchema>

const accessSummarySchema = z.object({
  organizationId: z.string().min(1).optional().catch(undefined),
  principal: z.object({ kind: z.string() }).optional().catch(undefined),
})

/** The calling shell, for metrics only. The header is client-supplied and never authorizes. */
export function getShellClient(headers: Headers): z.infer<typeof shellClientSchema> {
  const client = headers.get(platformHeaders['x-playbook-client'])?.trim().toLowerCase()
  return shellClientSchema.catch(shellClientSchema.enum.unknown).parse(client)
}

function failureResponse(failure: ApiFailure): Response {
  return NextResponse.json(
    { ...toErrorBody(failure), ...failure.extra },
    { headers: failure.headers, status: failure.status }
  )
}

/** The documented error envelope, for a handler that rejects a request it already authorized. */
export function errorResponse(
  status: HttpErrorStatus,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return failureResponse({ ...failureForStatus(status, message), extra })
}

function logFailure(route: string, requestId: string, detail: unknown): Response {
  console.error('Platform API route failed.', JSON.stringify({ requestId, route }), detail)
  return failureResponse(failureForStatus(500, 'Internal server error.'))
}

async function readBody(contract: RouteContract, request: NextRequest): Promise<unknown> {
  if (contract.body === noInputSchema) return undefined
  const text = await readBoundedText(request, contract.maxBodyBytes)
  return contract.bodyFormat === bodyFormatSchema.enum.text ? text : JSON.parse(text)
}

async function readRaw(
  contract: RouteContract,
  request: NextRequest,
  params: RouteParams
): Promise<RawRequest> {
  return {
    body: await readBody(contract, request),
    headers: Object.fromEntries(request.headers),
    params,
    query: Object.fromEntries(request.nextUrl.searchParams),
  }
}

function readRawOnce(contract: RouteContract, request: NextRequest, params: RouteParams) {
  let pending: Promise<RawRequest> | undefined
  return () => (pending ??= readRaw(contract, request, params))
}

function parseOptional(schema: z.ZodType, value: unknown): Promise<unknown> {
  return schema === noInputSchema ? Promise.resolve(undefined) : schema.parseAsync(value)
}

async function parseInput(contract: RouteContract, raw: RawRequest) {
  return {
    params: await contract.params.parseAsync(raw.params),
    query: await parseOptional(contract.query, raw.query),
    headers: await parseOptional(contract.headers, raw.headers),
    body: await contract.body.parseAsync(raw.body),
  }
}

/** What one pass through the pipeline produced: the resolved caller (if any) and the response. */
export const routeOutcomeSchema = z.object({
  access: z.unknown(),
  response: z.instanceof(Response),
})

type Outcome = z.infer<typeof routeOutcomeSchema>

/**
 * A binding with its contract types erased. The pipeline does not need the
 * precise types, so it runs on this shape; `route()` keeps them at its boundary.
 */
export const erasedRouteBindingSchema = z.object({
  auth: authenticatorSchema(z.unknown()),
  handler: z.function({ input: [z.unknown()], output: z.promise(z.unknown()) }),
  status: z.function({ input: [z.unknown()], output: httpSuccessStatusSchema }).optional(),
})

type ErasedBinding = z.input<typeof erasedRouteBindingSchema>

async function renderOutput(
  contract: RouteContract,
  binding: ErasedBinding,
  output: unknown,
  requestId: string
): Promise<Response> {
  if (output instanceof Response) return output
  const parsed = await contract.output.safeParseAsync(output)
  if (!parsed.success) return logFailure(contract.name, requestId, z.prettifyError(parsed.error))
  const status = binding.status?.(parsed.data) ?? contract.status
  return status === 204
    ? new Response(null, { status })
    : NextResponse.json(parsed.data, { status })
}

async function runRoute(
  contract: RouteContract,
  binding: ErasedBinding,
  request: NextRequest,
  params: RouteParams
): Promise<Outcome> {
  const requestId = getRequestId(request.headers)
  if (isCrossOriginCookieMutation(request)) {
    return {
      access: undefined,
      response: failureResponse(
        failureForStatus(403, 'Cross-origin cookie-authenticated writes are not allowed.')
      ),
    }
  }
  if (contract.shell && request.headers.has(platformHeaders['x-api-key'])) {
    const message = 'Shell endpoints require a signed-in user session, not an API key.'
    return { access: undefined, response: failureResponse(failureForStatus(403, message)) }
  }
  let access: unknown
  try {
    const raw = readRawOnce(contract, request, params)
    access = await binding.auth({ raw, request })
    const input = await parseInput(contract, await raw())
    const output = await binding.handler({ ...input, access, request, requestId })
    return { access, response: await renderOutput(contract, binding, output, requestId) }
  } catch (error) {
    const failure = toApiFailure(error)
    const response = failure
      ? failureResponse(failure)
      : logFailure(contract.name, requestId, error)
    return { access, response }
  }
}

function logRequest(entry: RouteLogEntry): void {
  // eslint-disable-next-line no-console
  console.info(JSON.stringify(entry))
}

/**
 * Bind `contract` to its authenticator and handler, returning the Next.js
 * route handler: `export const POST = route(createReleaseContract, { … })`.
 */
export function route<C extends RouteContract, Access>(
  contract: C,
  binding: RouteBinding<C, Access> & { auth: Authenticate<Access> }
): RouteExport {
  const erased = binding as unknown as ErasedBinding
  return async (request, context) => {
    const startedAt = performance.now()
    // Next.js passes no params for routes without dynamic segments.
    const params = (await context?.params) ?? {}
    const readScope = request.method === 'GET' || request.method === 'HEAD' ? new Map() : undefined
    const { access, response } = await withRequestReads(readScope, () =>
      runRoute(contract, erased, request, params)
    )
    const requestId = getRequestId(request.headers)
    response.headers.set(platformHeaders['x-request-id'], requestId)
    if (!response.headers.has(platformHeaders['cache-control'])) {
      response.headers.set(platformHeaders['cache-control'], 'private, no-store')
    }
    const summary = accessSummarySchema.parse(access ?? {})
    logRequest({
      client: getShellClient(request.headers),
      durationMs: Math.round(performance.now() - startedAt),
      event: contract.shell
        ? routeLogEventSchema.enum['playbook.shell_request']
        : routeLogEventSchema.enum['playbook.api_request'],
      method: request.method,
      organizationId: summary.organizationId,
      principal: summary.principal?.kind,
      requestId,
      route: contract.name,
      status: response.status,
    })
    return response
  }
}

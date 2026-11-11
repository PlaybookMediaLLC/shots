import 'server-only'

import { createHash, createHmac } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { constantTimeEqual, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { serviceBackend } from '@/lib/backend/sdk'
import { getAuthSecret } from './environment'

const inputSchema = z
  .object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(4096),
    client_id: z.string().min(1).max(160).optional(),
    client_secret: z.string().optional(),
  })
  .passthrough()
const grantSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  clientId: z.string(),
  expiresAt: z.coerce.date(),
  revoked: z.coerce.date().nullable(),
})
const clientSchema = z.object({
  public: z.boolean().nullable(),
  disabled: z.boolean().nullable(),
  clientSecret: z.string().nullable(),
})
const leaseSchema = z.object({ value: z.string(), expiresAt: z.coerce.date() })
const resultSchema = z.object({
  fingerprint: z.string(),
  response: z.string().nullable(),
  pendingUntil: z.number().optional(),
})
const headers = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  pragma: 'no-cache',
}
const failure = (error = 'invalid_grant', status = 400) =>
  Response.json({ error }, { status, headers })
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')

type Refresh = { clientId: string; tokenHash: string; id: string; key: string; fingerprint: string }
const leaseWhere = (exchange: Refresh) => [{ field: 'id', value: exchange.id }]

async function readRefresh(request: Request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/api/auth/oauth2/token')
    return null
  let raw: unknown
  try {
    raw = request.headers.get('content-type')?.includes('application/json')
      ? await request.clone().json()
      : Object.fromEntries(new URLSearchParams(await request.clone().text()))
  } catch {
    return failure('invalid_request')
  }
  if (!z.object({ grant_type: z.literal('refresh_token') }).safeParse(raw).success) return null
  const parsed = inputSchema.safeParse(raw)
  return parsed.success ? parsed.data : failure('invalid_request')
}

function clientCredentials(authorization: string, input: z.infer<typeof inputSchema>) {
  if (!authorization.startsWith('Basic '))
    return { id: input.client_id, secret: input.client_secret }
  const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  return separator < 1
    ? { id: undefined, secret: undefined }
    : { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) }
}

async function refreshContext(
  request: Request,
  input: z.infer<typeof inputSchema>
): Promise<Refresh | Response> {
  const authorization = request.headers.get('authorization') ?? ''
  const credentials = clientCredentials(authorization, input)
  if (!credentials.id || credentials.id.length > 160) return failure('invalid_client', 401)
  const row = (
    await serviceBackend().authStore({
      model: 'oauthClient',
      op: 'findOne',
      where: [{ field: 'clientId', value: credentials.id }],
    })
  ).row
  if (!row) return failure('invalid_client', 401)
  const client = clientSchema.parse(row)
  if (client.disabled) return failure('invalid_client', 401)
  if (
    !client.public &&
    (!credentials.secret ||
      !client.clientSecret ||
      !constantTimeEqual(hash(credentials.secret), client.clientSecret))
  )
    return failure('invalid_client', 401)
  const key = getAuthSecret()
  const tokenHash = hash(input.refresh_token)
  const fingerprint = createHmac('sha256', key)
    .update(
      JSON.stringify([authorization, Object.entries(input).sort(([a], [b]) => a.localeCompare(b))])
    )
    .digest('hex')
  return {
    key,
    tokenHash,
    fingerprint,
    clientId: credentials.id,
    id: `founder-hub-refresh:${tokenHash}`,
  }
}

async function readGrant(exchange: Refresh) {
  const row = (
    await serviceBackend().authStore({
      model: 'oauthRefreshToken',
      op: 'findOne',
      where: [{ field: 'token', value: exchange.tokenHash }],
    })
  ).row
  if (!row) return null
  const grant = grantSchema.parse(row)
  return grant.clientId === exchange.clientId && grant.expiresAt.getTime() > Date.now()
    ? grant
    : null
}

async function readRetry(exchange: Refresh): Promise<Response | 'pending' | null> {
  const row = (
    await serviceBackend().authStore({
      model: 'verification',
      op: 'findOne',
      where: leaseWhere(exchange),
    })
  ).row
  if (!row) return null
  const lease = leaseSchema.parse(row)
  if (lease.expiresAt.getTime() <= Date.now()) return null
  const result = resultSchema.parse(
    JSON.parse(await symmetricDecrypt({ key: exchange.key, data: lease.value }))
  )
  if (result.fingerprint !== exchange.fingerprint) return failure('invalid_request')
  if (result.response !== null) return new Response(result.response, { headers })
  return result.pendingUntil && result.pendingUntil > Date.now() ? 'pending' : failure()
}

async function claimRefresh(exchange: Refresh, grant: z.infer<typeof grantSchema>) {
  const now = new Date().toISOString()
  try {
    await serviceBackend().authStore({
      model: 'verification',
      op: 'create',
      data: {
        id: exchange.id,
        identifier: exchange.id,
        value: await symmetricEncrypt({
          key: exchange.key,
          data: JSON.stringify({
            fingerprint: exchange.fingerprint,
            response: null,
            pendingUntil: Date.now() + 30_000,
          }),
        }),
        createdAt: now,
        updatedAt: now,
        expiresAt: grant.expiresAt.toISOString(),
      },
    })
    return true
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 409) return false
    throw error
  }
}

async function recordRefresh(exchange: Refresh, response: Response) {
  try {
    await serviceBackend().authStore({
      model: 'verification',
      op: 'update',
      where: leaseWhere(exchange),
      data: {
        value: await symmetricEncrypt({
          key: exchange.key,
          data: JSON.stringify({
            fingerprint: exchange.fingerprint,
            response: await response.clone().text(),
          }),
        }),
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        updatedAt: new Date().toISOString(),
      },
    })
  } catch {
    // Preserve the new credential; an uncertain rotation must never dispatch the old token again.
    console.error(
      'OAuth refresh result could not be cached; this session may require sign-in after a lost response.'
    )
  }
}

async function rotateRefresh(
  exchange: Refresh,
  request: Request,
  handle: (request: Request) => Promise<Response>
) {
  const response = await handle(request)
  if (response.ok) await recordRefresh(exchange, response)
  else if (response.status < 500) {
    const current = await readGrant(exchange)
    if (current && !current.revoked)
      await serviceBackend().authStore({
        model: 'verification',
        op: 'delete',
        where: leaseWhere(exchange),
      })
  }
  return response
}

async function rejectReuse(grant: z.infer<typeof grantSchema>) {
  // Deleting the session also prevents an in-flight rotation from recreating a grant.
  await serviceBackend().authStore({
    model: 'session',
    op: 'delete',
    where: [
      { field: 'id', value: grant.sessionId },
      { field: 'userId', value: grant.userId },
    ],
  })
  return failure()
}

/** Serializes provider rotation in the shared auth store and replays an encrypted result for 15 seconds. */
export async function refreshOAuthToken(
  request: Request,
  handle: (request: Request) => Promise<Response>
): Promise<Response> {
  const input = await readRefresh(request)
  if (!input) return handle(request)
  if (input instanceof Response) return input
  const exchange = await refreshContext(request, input)
  if (exchange instanceof Response) return exchange
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const grant = await readGrant(exchange)
    if (!grant) return failure()
    const retry = await readRetry(exchange)
    if (retry instanceof Response) return retry
    if (retry === 'pending') {
      await setTimeout(100)
      continue
    }
    if (grant.revoked) return rejectReuse(grant)
    if (await claimRefresh(exchange, grant)) return rotateRefresh(exchange, request, handle)
  }
  return failure('temporarily_unavailable', 503)
}

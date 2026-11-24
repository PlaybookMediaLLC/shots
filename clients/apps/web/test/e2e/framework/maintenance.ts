import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const maintenanceSecretHeader = 'x-shots-maintenance-secret'

export function getMaintenanceHeaders(): Record<string, string> {
  const secret = process.env.E2E_MAINTENANCE_SECRET
  if (!secret) {
    throw new Error('E2E_MAINTENANCE_SECRET must be set by the local stack command.')
  }

  return { [maintenanceSecretHeader]: secret }
}

/** Ask the real Temporal worker to dispatch queued jobs without waiting for its minute tick. */
export async function triggerTenantOutbox(): Promise<void> {
  const base = process.env.E2E_TEMPORAL_UI_URL ?? 'http://127.0.0.1:8233'
  const schedule = new URL(
    '/api/v1/namespaces/default/schedules/platform-maintenance-tenant-outbox',
    base
  )
  const session = await fetch(schedule, { signal: AbortSignal.timeout(15_000) })
  if (!session.ok) throw new Error(`Temporal schedule lookup returned ${session.status}.`)
  const cookies = session.headers.getSetCookie().map((cookie) => cookie.split(';')[0])
  const csrf = z
    .string()
    .min(1)
    .parse(cookies.find((cookie) => cookie.startsWith('_csrf='))?.slice(6))
  const response = await fetch(`${schedule}/patch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies.join('; '),
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      identity: 'shots-browser-tests',
      patch: { triggerImmediately: { overlapPolicy: 'SCHEDULE_OVERLAP_POLICY_BUFFER_ONE' } },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Temporal outbox trigger returned ${response.status}.`)
  z.strictObject({}).parse(await response.json())
}

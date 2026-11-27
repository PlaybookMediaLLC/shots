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

/** Ask the real Temporal worker to dispatch queued outbox jobs immediately. */
export async function triggerTenantOutbox(): Promise<void> {
  const base = process.env.E2E_TEMPORAL_UI_URL ?? 'http://127.0.0.1:8233'
  const namespace = new URL('/api/v1/namespaces/default', base)
  const session = await fetch(namespace, { signal: AbortSignal.timeout(15_000) })
  if (!session.ok) throw new Error(`Temporal namespace lookup returned ${session.status}.`)
  const cookies = session.headers.getSetCookie().map((cookie) => cookie.split(';')[0])
  const csrf = z
    .string()
    .min(1)
    .parse(cookies.find((cookie) => cookie.startsWith('_csrf='))?.slice(6))
  const workflowId = `e2e-tenant-outbox-${randomUUID()}`
  const workflow = new URL(`/api/v1/namespaces/default/workflows/${workflowId}`, base)
  const response = await fetch(workflow, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookies.join('; '),
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      identity: 'shots-browser-tests',
      workflowType: { name: 'platform-maintenance-v1' },
      taskQueue: { name: 'platform-maintenance' },
      workflowExecutionTimeout: '120s',
      input: {
        payloads: [
          {
            metadata: { encoding: Buffer.from('json/plain').toString('base64') },
            data: Buffer.from(JSON.stringify('tenant-outbox')).toString('base64'),
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Temporal outbox trigger returned ${response.status}.`)
  z.object({ runId: z.string().min(1) }).parse(await response.json())
}

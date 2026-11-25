import { db, expect, test, trpcMutation, trpcQuery } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const connection = {
  name: 'Email sign-in app',
  environment: 'staging',
  origin: 'https://app.example.com',
  hosts: ['app.example.com'],
  loginHosts: [],
  protectedPath: '/dashboard',
  identitySelector: '[data-testid=account]',
  expectedAccount: 'Demo account',
}

// The suite runs with no browser provider and no Resend receiving domain, the
// state most deployments start in. Email sign-in (RFC 007A) must say it is not
// configured, save nothing, stay inside its workspace, and refuse any webhook
// that Resend did not sign.
test('email sign-in reports it is not configured and saves nothing', async ({
  page,
  workspace,
}) => {
  const assigned = await trpcMutation(page, 'capture.createConnection', {
    ...connection,
    name: 'Assigned address',
    expectedAccount: '',
    assignTestEmail: true,
  })
  expect(assigned.status).toBe(503)
  const none = await db.query(
    `SELECT 1 FROM platform_app_connection WHERE "organizationId"=$1 AND name='Assigned address'`,
    [workspace.id]
  )
  expect(none.rowCount).toBe(0)

  const created = await trpcMutation(page, 'capture.createConnection', connection)
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const overview = (await trpcQuery(page, 'capture.overview')).body as {
    connections: Array<{ id: string }>
  }
  const id = overview.connections[0]!.id
  const setup = await trpcQuery(page, 'capture.emailAuth', { id })
  expect(setup.status).toBe(503)
  const test = await trpcMutation(page, 'capture.testEmailAuth', { id })
  expect(test.status).toBe(503)
  const rows = await db.query(`SELECT 1 FROM capture_auth_attempt WHERE "organizationId"=$1`, [
    workspace.id,
  ])
  expect(rows.rowCount).toBe(0)
})

test('the Resend webhook refuses an unsigned delivery', async ({ request }) => {
  const unsigned = await request.post('/api/webhooks/resend/capture-auth', {
    data: '{"type":"email.received","data":{"email_id":"em_1","to":["x@y.z"]}}',
    headers: { 'content-type': 'application/json' },
  })
  expect(unsigned.status()).toBe(401)
  const forged = await request.post('/api/webhooks/resend/capture-auth', {
    data: '{"type":"email.received","data":{"email_id":"em_1","to":["x@y.z"]}}',
    headers: {
      'content-type': 'application/json',
      'svix-id': 'msg_forged',
      'svix-signature': 'v1,Zm9yZ2Vk',
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
    },
  })
  // Without a receiving domain the backend answers unavailable; with one it
  // answers that the signature did not verify. Neither accepts it.
  expect([401, 503]).toContain(forged.status())
  const receipts = await db.query(
    `SELECT 1 FROM capture_inbound_receipt WHERE "providerEventId"='msg_forged'`
  )
  expect(receipts.rowCount).toBe(0)
})

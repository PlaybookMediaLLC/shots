import { createWorkspace, db, expect, test, trpcMutation, trpcQuery } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

type Overview = {
  available: boolean
  connections: Array<{ id: string; name: string; status: string; revokedAt: string | null }>
  recipes: Array<{ id: string; status: string; version: number }>
}

const connection = {
  name: 'Staging app',
  environment: 'staging',
  origin: 'https://app.example.com',
  hosts: ['app.example.com'],
  loginHosts: [],
  protectedPath: '/dashboard',
  identitySelector: '[data-testid=account]',
  expectedAccount: 'demo@example.com',
}

// The suite has no browser provider, which is the state most deployments start
// in: everything up to signing in works, and signing in says it is not configured.
test('an admin registers a signed-in app, and another workspace cannot reach it', async ({
  app,
  browser,
  identity,
  page,
  workspace,
}) => {
  await app.open('/workflows/connections')
  await expect(page.getByRole('heading', { name: 'Signed-in capture', exact: true })).toBeVisible()

  // With no provider, the page says so and offers no form that cannot finish.
  await expect(page.getByText(/not configured|(?:isn.t|is not) set up/i).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add connection' })).toHaveCount(0)

  // A private address is refused with a reason, and nothing is saved.
  const refused = await trpcMutation(page, 'capture.createConnection', {
    ...connection,
    origin: 'https://10.0.0.8',
    hosts: ['10.0.0.8'],
  })
  expect(refused.status).toBe(400)
  expect(JSON.stringify(refused.body)).toMatch(/origin/i)
  const none = await db.query(`SELECT 1 FROM platform_app_connection WHERE "organizationId"=$1`, [
    workspace.id,
  ])
  expect(none.rowCount).toBe(0)

  const created = await trpcMutation(page, 'capture.createConnection', connection)
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const overview = await trpcQuery(page, 'capture.overview')
  const body = overview.body as Overview
  expect(body.available).toBe(false)
  const [saved] = body.connections
  expect(saved).toMatchObject({ name: 'Staging app', status: 'CONNECTING' })
  // No response carries session material, or a way to fetch it.
  expect(JSON.stringify(body)).not.toMatch(/stateCiphertext|connectIntentId|connectSessionId/)

  await app.open('/workflows/connections')
  await expect(page.getByRole('heading', { name: 'Staging app' })).toBeVisible()

  // Signing in needs the provider: a plain failure, and no browser or state.
  const connect = await trpcMutation(page, 'capture.connect', { id: saved?.id })
  expect(connect.status).toBe(503)
  const row = await db.query(
    `SELECT status, "stateCiphertext", "connectSessionId" FROM platform_app_connection WHERE id=$1`,
    [saved?.id]
  )
  expect(row.rows[0]).toMatchObject({
    status: 'CONNECTING',
    stateCiphertext: null,
    connectSessionId: null,
  })

  // Another workspace sees nothing, and cannot act on the ID.
  const otherContext = await browser.newContext()
  try {
    const otherPage = await otherContext.newPage()
    await createWorkspace(
      {
        ...identity,
        email: `other-${identity.email}`,
        workspaceName: `Other ${identity.workspaceName}`,
      },
      otherPage
    )
    const theirs = (await trpcQuery(otherPage, 'capture.overview')).body as Overview
    expect(theirs.connections).toHaveLength(0)
    const revoke = await trpcMutation(otherPage, 'capture.revokeConnection', { id: saved?.id })
    expect(revoke.status).toBe(404)
    const kept = await db.query(`SELECT status FROM platform_app_connection WHERE id=$1`, [
      saved?.id,
    ])
    expect(kept.rows[0]).toMatchObject({ status: 'CONNECTING' })
  } finally {
    await otherContext.close()
  }

  // Revoking is final and recorded.
  const revoked = await trpcMutation(page, 'capture.revokeConnection', { id: saved?.id })
  expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
  const after = (await trpcQuery(page, 'capture.overview')).body as Overview
  expect(after.connections[0]?.status).toBe('REVOKED')
  const audit = await db.query(
    `SELECT 1 FROM audit_log WHERE "organizationId"=$1 AND action='product.capture_connection_revoked'`,
    [workspace.id]
  )
  expect(audit.rowCount).toBe(1)
})

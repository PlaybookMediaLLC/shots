import {
  chooseOption,
  createWorkspace,
  db,
  expect,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('frontend rules save once, preview without side effects, and isolate evidence', async ({
  app,
  browser,
  identity,
  page,
  workspace,
}) => {
  const id = `frontend-${workspace.id}`
  const policy = {
    schemaVersion: 1,
    environments: ['production'],
    branch: '',
    tag: '',
    domain: '',
    workflowId: '',
    job: '',
    checks: [],
    alerts: ['matched'],
    workflowVersionId: '',
  }
  // Seed a paused, already connected project. Authentication, policy saves,
  // authorization and preview all use the real web/API/database stack.
  await db.query(
    `INSERT INTO source_app (id, "organizationId", name, provider, "externalId", "allowedHosts", status, "updatedAt")
     VALUES ($1, $2, 'Frontend fixture', 'vercel', $1, '[]', 'ACTIVE', now())`,
    [id, workspace.id]
  )
  await db.query(
    `INSERT INTO frontend_source (id, "organizationId", provider, "accountId", "projectId", policy, enabled)
     VALUES ($1, $2, 'vercel', 'isolated-team', $1, $3, false)`,
    [id, workspace.id, policy]
  )
  const otherContext = await browser.newContext()
  try {
    await app.open(`/workflows/deployments?source=${id}`)
    await expect(page.getByRole('heading', { name: 'Edit production policy' })).toBeVisible()
    await page.getByLabel('Frontend name', { exact: true }).fill('Production frontend')
    await page.getByRole('button', { name: 'Save production policy', exact: true }).click()
    await expect(
      page.getByText('Production policy saved. Historical events will not be replayed.')
    ).toBeVisible()
    expect(
      await db.row('SELECT revision, enabled FROM frontend_source WHERE id = $1', [id])
    ).toMatchObject({ revision: 2, enabled: false })
    expect(await db.row('SELECT name FROM source_app WHERE id = $1', [id])).toMatchObject({
      name: 'Production frontend',
    })

    await chooseOption(page.getByLabel('Representative event'), 'Build ready, publication pending')
    await page.getByRole('button', { name: 'Preview policy', exact: true }).click()
    await expect(page.getByText('Build or production publication remains pending.')).toBeVisible()
    await chooseOption(page.getByLabel('Representative event'), 'Production active, checks pass')
    await page.getByRole('button', { name: 'Preview policy', exact: true }).click()
    await expect(
      page.getByText('Provider reported a successful production deployment.', { exact: true })
    ).toBeVisible()
    expect(
      await db.row(
        'SELECT count(*)::int AS count FROM frontend_observation WHERE "sourceId" = $1',
        [id]
      )
    ).toMatchObject({ count: 0 })
    expect(
      await db.row(
        `SELECT count(*)::int AS count FROM outbox_event WHERE "organizationId" = $1 AND type LIKE 'activity.frontend.%'`,
        [workspace.id]
      )
    ).toMatchObject({ count: 0 })

    const save = {
      id,
      revision: 1,
      name: 'Stale change',
      provider: 'vercel',
      accountId: 'isolated-team',
      projectId: id,
      githubSourceId: '',
      enabled: false,
      token: '',
      secret: '',
      policy,
    }
    expect((await trpcMutation(page, 'frontendDeployments.save', save)).status).toBe(409)
    expect(
      (await trpcMutation(page, 'frontendDeployments.save', { ...save, revision: 2, name: '' }))
        .status
    ).toBe(400)

    const otherPage = await otherContext.newPage()
    await createWorkspace(
      {
        ...identity,
        email: `other-${identity.email}`,
        workspaceName: `Other ${identity.workspaceName}`,
      },
      otherPage
    )
    expect((await trpcQuery(otherPage, 'frontendDeployments.history', { id })).status).toBe(404)
    const denied = await trpcMutation(otherPage, 'frontendDeployments.save', {
      ...save,
      revision: 2,
    })
    expect([403, 404]).toContain(denied.status)
    expect(await db.row('SELECT revision FROM frontend_source WHERE id = $1', [id])).toMatchObject({
      revision: 2,
    })
    await app.reload()
    await expect(page.getByLabel('Frontend name', { exact: true })).toHaveValue(
      'Production frontend'
    )
  } finally {
    await otherContext.close()
    await db.query('DELETE FROM frontend_source WHERE id = $1 AND "organizationId" = $2', [
      id,
      workspace.id,
    ])
    await db.query('DELETE FROM source_app WHERE id = $1 AND "organizationId" = $2', [
      id,
      workspace.id,
    ])
  }
})

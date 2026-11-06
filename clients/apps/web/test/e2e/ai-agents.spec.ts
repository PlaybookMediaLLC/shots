import { randomUUID } from 'node:crypto'
import { browserRequest, chooseOption, db, expect, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('an owner creates an agent key whose snippets carry it, and the key cannot approve', async ({
  app,
  page,
}) => {
  await app.open('/settings/ai-agents')

  await expect(page.getByRole('heading', { name: 'MCP server' })).toBeVisible()
  await expect(page.getByLabel('Server URL', { exact: true })).toHaveValue(/\/mcp$/)
  // Agent keys start able to read, write drafts, and upload media.
  await expect(page.getByLabel(/^artifact:read/)).toBeChecked()
  await expect(page.getByLabel(/^draft:write/)).toBeChecked()
  await expect(page.getByLabel(/^asset:write/)).toBeChecked()
  // Scheduling and posting are opt-in per key.
  await expect(page.getByLabel(/^post:schedule/)).not.toBeChecked()
  await expect(page.getByLabel(/^post:publish/)).not.toBeChecked()

  await page.getByRole('button', { name: 'Create agent key' }).click()
  await expect(page.getByText('Copy this key now')).toBeVisible()
  const key = await page.getByLabel('API key', { exact: true }).inputValue()
  expect(key).toMatch(/^ss_/)

  await page.getByRole('tab', { name: 'Cursor' }).click()
  const snippet = JSON.parse(await page.locator('pre code').first().innerText())
  expect(snippet.mcpServers.shots.headers.Authorization).toBe(`Bearer ${key}`)

  // The key reads the workspace through REST, and a decision stays human-only.
  const campaigns = await browserRequest(page, '/api/v1/campaigns', {
    headers: { 'x-api-key': key },
  })
  expect(campaigns.status).toBe(200)
  const approve = await browserRequest(
    page,
    '/api/v1/campaigns/cl00000000000000000000000/approvals',
    {
      body: JSON.stringify({ decision: 'approve' }),
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      method: 'POST',
    }
  )
  expect(approve.status).toBe(403)
})

test('the consent page refuses an unregistered client without redirecting', async ({
  app,
  page,
}) => {
  await app.open(
    '/oauth/authorize?response_type=code&client_id=unregistered&redirect_uri=https%3A%2F%2Fevil.test%2Fcb&state=s1'
  )
  await expect(page.getByRole('heading', { name: /can’t be approved/ })).toBeVisible()
  expect(page.url()).toContain('/oauth/authorize')
})

test('agent consent serializes selected scopes and supports clearing an expiry', async ({
  app,
  page,
}) => {
  const clientId = `e2e-consent-${randomUUID()}`
  const redirectUri = 'https://agent.example.test/callback'
  try {
    await db.query(
      `INSERT INTO "OAuthApp" (id, name, "redirectUrl", "clientId", "createdAt", "updatedAt")
       VALUES ($1, 'UI consent fixture', $2, $1, now(), now())`,
      [clientId, redirectUri]
    )
    await app.open(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
      })}`
    )
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Approve', exact: true }) })
    await expect(page.getByRole('heading', { name: 'Connect UI consent fixture?' })).toBeVisible()
    const submittedChoices = () =>
      form.evaluate((element) => {
        const data = new FormData(element as HTMLFormElement)
        return { expiry: data.get('expiresInDays'), scopes: data.getAll('scopes') }
      })
    await expect.poll(submittedChoices).toEqual({
      expiry: '',
      scopes: ['artifact:read', 'asset:write', 'draft:write', 'release:create', 'upload:sign'],
    })
    await page.getByLabel(/release:create/).uncheck()
    await page.getByLabel(/^draft:write/).uncheck()
    await page.getByLabel(/upload:sign/).uncheck()
    const expiry = page.getByRole('combobox', { name: 'Access expires', exact: true })
    await expiry.press('Space')
    await page.getByRole('option', { name: 'In 30 days', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(submittedChoices)
      .toEqual({ expiry: '30', scopes: ['artifact:read', 'asset:write'] })
    await chooseOption(expiry, 'Never (revoke it in Settings → AI agents)')
    await expect
      .poll(submittedChoices)
      .toEqual({ expiry: '', scopes: ['artifact:read', 'asset:write'] })
  } finally {
    await db.query('DELETE FROM "OAuthApp" WHERE id=$1', [clientId])
  }
})

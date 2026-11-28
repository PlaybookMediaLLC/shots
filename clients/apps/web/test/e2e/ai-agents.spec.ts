import { randomUUID } from 'node:crypto'
import { browserRequest, chooseOption, db, expect, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('an owner creates an API key from Agents & API keys, inspects tabs & markdown briefs, and verifies scope enforcement', async ({
  app,
  page,
}) => {
  await app.open('/settings/ai-agents')

  await expect(page.getByRole('heading', { name: 'Agents & API keys' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connected agents' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect an AI agent' })).toBeVisible()

  // Open the modal API key creation dialog.
  await page.getByRole('button', { name: 'Create API key' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Create API key' })
  await expect(dialog).toBeVisible()

  // Default scopes allow reading, drafting, and uploading; publish/delete stay opt-in.
  await expect(dialog.getByLabel(/artifact:read/)).toBeChecked()
  await expect(dialog.getByLabel(/draft:write/)).toBeChecked()
  await expect(dialog.getByLabel(/asset:write/)).toBeChecked()
  await expect(dialog.getByLabel(/post:schedule/)).not.toBeChecked()
  await expect(dialog.getByLabel(/post:publish/)).not.toBeChecked()
  await expect(dialog.getByLabel(/post:delete/)).not.toBeChecked()

  await dialog.getByLabel('Key name').fill('E2E agent key')
  await dialog.getByRole('button', { name: 'Create API key' }).click()
  const statusNotice = page.getByRole('status').filter({ hasText: 'Copy this key now' })
  await expect(statusNotice).toBeVisible()
  const key = (await statusNotice.locator('code').first().innerText()).trim()
  expect(key).toMatch(/^ss_/)

  // Switching to CLI / API and Muse auto-fills the freshly minted key; OAuth tabs never embed it.
  await page.getByRole('tab', { name: 'CLI / API' }).click()
  await expect(page.locator('pre code').first()).toContainText(`X-API-Key: ${key}`)
  await expect(page.locator('pre code').first()).toContainText('/api/v1/auth/me')
  await page.getByRole('tab', { name: 'Muse' }).click()
  await expect(page.locator('pre code').first()).toContainText(`X-API-Key: ${key}`)
  await page.getByRole('tab', { name: 'Cursor' }).click()
  const cursorSnippet = JSON.parse(await page.locator('pre code').first().innerText())
  expect(cursorSnippet.mcpServers.shots.type).toBe('http')
  expect(cursorSnippet.mcpServers.shots.headers).toBeUndefined()

  // Live Markdown agent brief serves 200 text/markdown with Claude brief content.
  const brief = await page.request.get('/docs/agents/claude.md')
  expect(brief.status()).toBe(200)
  expect(brief.headers()['content-type'] ?? '').toContain('text/markdown')
  expect(await brief.text()).toContain('# Shots Agent Guide for Claude')

  // Key introspection verifies the key and refuses session-only calls without X-API-Key.
  const keyInfo = await browserRequest(page, '/api/v1/auth/me', {
    headers: { 'x-api-key': key },
  })
  expect(keyInfo.status).toBe(200)
  expect(JSON.stringify(keyInfo.body)).not.toContain(key)
  const sessionOnlyMe = await browserRequest(page, '/api/v1/auth/me')
  expect(sessionOnlyMe.status).toBe(403)

  // The key reads the workspace through REST, and decisions stay human-only.
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
  const remove = await browserRequest(
    page,
    '/api/v1/content-draft-posts/cl00000000000000000000000/delete',
    { headers: { 'x-api-key': key }, method: 'POST' }
  )
  expect(remove.status).toBe(403)
})

test('connected OAuth agents group multiple sessions, expand cleanly, and support Revoke all', async ({
  app,
  page,
  workspace,
}) => {
  const id1 = `e2e_oauth_${randomUUID().slice(0, 12)}`
  const id2 = `e2e_oauth_${randomUUID().slice(0, 12)}`
  const idCodex = `e2e_oauth_${randomUUID().slice(0, 12)}`
  const metaClaude = JSON.stringify({
    clientId: 'pcd_claude_e2e',
    clientName: 'Claude Code',
    grantId: 'grant_e2e',
    source: 'agent',
  })
  const metaCodex = JSON.stringify({
    clientId: 'pcd_codex_e2e',
    clientName: 'Codex',
    grantId: 'grant_codex_e2e',
    source: 'agent',
  })
  const perms = JSON.stringify({ artifact: ['read'], draft: ['write'] })
  await db.query(
    `INSERT INTO apikey (id, name, start, prefix, key, "referenceId", enabled, permissions, metadata, "createdAt", "updatedAt")
     VALUES ($1, 'Claude Code (AI agent)', 'ss_cl1', 'ss_', $2, $7, true, $8, $9, now() - interval '1 hour', now()),
            ($3, 'Claude Code (AI agent)', 'ss_cl2', 'ss_', $4, $7, true, $8, $9, now(), now()),
            ($5, 'Codex (AI agent)', 'ss_cdx', 'ss_', $6, $7, true, $8, $10, now(), now())`,
    [
      id1,
      `hash_${id1}`,
      id2,
      `hash_${id2}`,
      idCodex,
      `hash_${idCodex}`,
      workspace.id,
      perms,
      metaClaude,
      metaCodex,
    ]
  )
  try {
    await app.open('/settings/ai-agents')
    const connectedTable = page.getByRole('table', { name: 'Connected OAuth AI agents' })
    await expect(connectedTable.getByText('Claude Code', { exact: true })).toBeVisible()
    await expect(connectedTable.getByText('2 sessions')).toBeVisible()
    await expect(connectedTable.getByText('Codex', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Toggle 2 sessions for Claude Code/ }).click()
    await expect(connectedTable.getByText('ss_cl1…')).toBeVisible()
    await expect(connectedTable.getByText('ss_cl2…')).toBeVisible()

    await page.getByRole('button', { name: /Revoke all 2 sessions for Claude Code/ }).click()
    await page.getByRole('button', { name: 'Revoke all sessions' }).click()
    await expect(connectedTable.getByText('Claude Code', { exact: true })).toHaveCount(0)
    await expect(connectedTable.getByText('Codex', { exact: true })).toBeVisible()
  } finally {
    await db.query('DELETE FROM apikey WHERE id = ANY($1::text[])', [[id1, id2, idCodex]])
  }
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
    await page.getByLabel(/draft:write/).uncheck()
    await page.getByLabel(/upload:sign/).uncheck()
    const expiry = page.getByRole('combobox', { name: 'Access expires', exact: true })
    await expiry.press('Space')
    await page.getByRole('option', { name: 'In 30 days', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(submittedChoices)
      .toEqual({ expiry: '30', scopes: ['artifact:read', 'asset:write'] })
    await chooseOption(expiry, 'Never (revoke it in Settings → Agents & API keys)')
    await expect
      .poll(submittedChoices)
      .toEqual({ expiry: '', scopes: ['artifact:read', 'asset:write'] })
  } finally {
    await db.query('DELETE FROM "OAuthApp" WHERE id=$1', [clientId])
  }
})

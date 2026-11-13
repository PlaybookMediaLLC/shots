import {
  apiRequest,
  bindTestGoOrganization,
  connectionAvailabilityFixture,
  createWorkspace,
  db,
  enableTwoFactor,
  expect,
  getE2EUrl,
  socialMockPort,
  startHttpMockServer,
  test,
  unbindTestGoOrganization,
  xVerification,
  type E2EIdentity,
  type HttpMockServer,
  type Page,
} from './framework'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { socialSetListSchema, socialSetSchema } from '../../lib/api/contracts/social-sets'

const beginSchema = z.object({ url: z.string() })
const receiptSchema = z.array(z.object({ exchangeStatus: z.string() }))

/**
 * A paid workspace bound to a local X adapter. Every authorization gets a new
 * token, and every exchange returns the same verified account, recording its
 * credentials in the shared database as the adapter does. No real provider
 * account is used.
 */
async function connectedWorkspace(
  page: Page,
  identity: E2EIdentity,
  open?: (path: string) => Promise<unknown>
) {
  const externalId = `identity-${randomUUID()}`
  let organizationId = ''
  const provider: HttpMockServer = await startHttpMockServer(async (request) => {
    if (request.url === '/api/public/v1/connection-availability')
      return { body: connectionAvailabilityFixture() }
    if (request.url === '/api/public/v1/me')
      return { body: { organization: { id: `go-${organizationId}` } } }
    if (request.url.startsWith('/api/public/v1/social/x'))
      return { body: { url: `https://api.x.com/oauth/authenticate?oauth_token=${randomUUID()}` } }
    if (request.url.startsWith('/api/public/v1/social/linkedin'))
      return {
        body: { url: `https://www.linkedin.com/oauth/v2/authorization?state=${randomUUID()}` },
      }
    if (request.url === '/integrations/social-connect/x') {
      await db.query(
        `INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token,"verifiedAccountKey","verifiedAccountKind","verifiedScopes","verifiedCapabilities","identityVerifiedAt")
         VALUES ($1,'123456789',$2,'Fixture X profile','x','social','fixture-only-credential',$3,$4,$5::jsonb,$6::jsonb,now())
         ON CONFLICT (id) DO UPDATE SET "verifiedAccountKey"=excluded."verifiedAccountKey",
           "verifiedAccountKind"=excluded."verifiedAccountKind", "verifiedScopes"=excluded."verifiedScopes",
           "verifiedCapabilities"=excluded."verifiedCapabilities", "identityVerifiedAt"=now()`,
        [
          externalId,
          `go-${organizationId}`,
          xVerification.accountKey,
          xVerification.accountKind,
          JSON.stringify(xVerification.grantedScopes),
          JSON.stringify(xVerification.capabilities),
        ]
      )
      return { body: { id: externalId, pages: [] } }
    }
    if (request.url === `/api/public/v1/integrations/${externalId}/identity`)
      return {
        body: {
          id: externalId,
          provider: 'x',
          nativeId: '123456789',
          name: 'Fixture X profile',
          handle: 'fixture_x',
          active: true,
          verifiedAt: new Date().toISOString(),
          verification: xVerification,
        },
      }
    if (request.url === '/api/public/v1/integrations')
      return { body: [{ id: externalId, identifier: 'x', disabled: false }] }
    return { status: 404 }
  }, socialMockPort)
  const begin = async (body: Record<string, string>) => {
    const response = await apiRequest(page, '/api/v1/social-connection-attempts', {
      method: 'POST',
      body,
    })
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
    const url = new URL(beginSchema.parse(response.body).url)
    return url.searchParams.get('oauth_token') ?? url.searchParams.get('state') ?? ''
  }
  const xCallback = (state: string) =>
    getE2EUrl(`/integrations/social/x?oauth_token=${state}&oauth_verifier=fixture-verifier`)
  const sets = async () => {
    const response = await apiRequest(page, '/api/v1/social-sets')
    expect(response.status).toBe(200)
    return socialSetListSchema.parse(response.body).items
  }
  const exchanges = () =>
    provider.calls.filter((call) => call.url.startsWith('/integrations/social-connect/')).length
  const cleanup = async () => {
    try {
      await db.query('DELETE FROM "Integration" WHERE "organizationId"=$1', [
        `go-${organizationId}`,
      ])
      await db.query('DELETE FROM "Organization" WHERE id=$1', [`go-${organizationId}`])
      await unbindTestGoOrganization(organizationId)
    } finally {
      // The mock holds this worker's port; the next test needs it free.
      await provider.close()
    }
  }
  try {
    await createWorkspace(identity, page)
    await enableTwoFactor(page, identity.password)
    organizationId = await bindTestGoOrganization(page)
    await db.query(
      `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Identity fixture',now())`,
      [`go-${organizationId}`]
    )
    // Authorization is a fixture page; no real provider account or credentials are used.
    await page.route('https://api.x.com/oauth/authenticate**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<main><h1>Fixture X authorization</h1></main>',
      })
    )
    let first: string
    if (open) {
      // A workspace profile started from its own button is shared with the workspace.
      await open('/settings/publishing-brands')
      await page.getByRole('button', { name: 'New workspace profile', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Shared with this workspace', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'X / Twitter', exact: true }).click()
      await dialog.getByRole('button', { name: 'Connect X account', exact: true }).click()
      await expect(page).toHaveURL(/^https:\/\/api\.x\.com\/oauth\/authenticate/)
      first = new URL(page.url()).searchParams.get('oauth_token') ?? ''
    } else {
      first = await begin({ provider: 'x', operation: 'CREATE_SET', creationVisibility: 'PRIVATE' })
    }
    // The first account creates its profile through the real callback.
    await page.goto(xCallback(first))
    await expect(page).toHaveURL(/\/settings\/publishing-brands\/[a-z0-9]+\?connected=x$/)
    const created = socialSetSchema.parse((await sets()).find((set) => set.accounts.length > 0))
    return { begin, cleanup, created, exchanges, externalId, sets, xCallback }
  } catch (error) {
    // Keep the setup failure, not a cleanup one, as the test's error.
    await cleanup().catch(() => undefined)
    throw error
  }
}

test(
  'an account already in a set is refused clearly, and denied or expired sign-ins change nothing',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    const { begin, cleanup, created, exchanges, sets, xCallback } = await connectedWorkspace(
      page,
      identity,
      (path) => app.open(path)
    )
    try {
      expect(created.visibility).toBe('WORKSPACE')
      const second = await apiRequest(page, '/api/v1/social-sets', {
        method: 'POST',
        body: { name: 'Second brand' },
      })
      expect(second.status).toBeLessThan(300)
      const secondId = socialSetSchema.parse(second.body).id
      const before = JSON.stringify(await sets())
      const exchanged = exchanges()

      // The same X account cannot join a second profile in this workspace.
      const duplicate = await begin({
        provider: 'x',
        operation: 'ADD_ACCOUNT',
        socialSetId: secondId,
      })
      const refused = await page.goto(xCallback(duplicate))
      expect(refused?.status()).toBe(409)
      const message = await page.locator('body').innerText()
      expect(message).toContain('already connected to another social set in this workspace')
      expect(message).not.toContain(created.id)
      expect(message).not.toContain(created.name)

      // A sign-in denied at the provider never reaches the backend.
      const denied = await begin({
        provider: 'linkedin',
        operation: 'ADD_ACCOUNT',
        socialSetId: secondId,
      })
      const deniedPage = await page.goto(
        getE2EUrl(`/integrations/social/linkedin?error=access_denied&state=${denied}`)
      )
      expect(deniedPage?.status()).toBe(400)
      await expect(page.getByText('Nothing was changed', { exact: false })).toBeVisible()
      const pending = await db.query(
        'SELECT "exchangeStatus" FROM social_oauth_start WHERE state=$1',
        [denied]
      )
      expect(receiptSchema.parse(pending.rows)).toEqual([{ exchangeStatus: 'PENDING' }])

      // An expired attempt is refused before the provider exchanges its code.
      const expired = await begin({
        provider: 'x',
        operation: 'ADD_ACCOUNT',
        socialSetId: secondId,
      })
      await db.query(
        `UPDATE social_oauth_start SET "expiresAt"=now()-interval '1 minute' WHERE state=$1`,
        [expired]
      )
      const late = await page.goto(xCallback(expired))
      expect(late?.status()).toBe(403)
      await expect(page.getByText('social connection expired; please start again')).toBeVisible()

      // The duplicate was exchanged once and refused at commitment; nothing else ran.
      expect(exchanges()).toBe(exchanged + 1)
      expect(JSON.stringify(await sets())).toBe(before)
    } finally {
      await cleanup()
    }
  }
)

test(
  'an unverified account explains the problem and reconnects in place',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    const { cleanup, created, externalId, sets, xCallback } = await connectedWorkspace(
      page,
      identity
    )
    try {
      expect(created.visibility).toBe('PRIVATE')
      const account = created.accounts[0]
      expect(account?.health).toBe('connected')
      await app.open(`/settings/publishing-brands/${created.id}`)
      await expect(page.getByText('Connected and ready to publish.')).toBeVisible()

      // Provider proof that is missing leaves the account unable to publish.
      await db.query(
        `UPDATE "Integration" SET "verifiedAccountKey"=NULL,"verifiedAccountKind"=NULL,"verifiedScopes"=NULL,
           "verifiedCapabilities"=NULL,"identityVerifiedAt"=NULL WHERE id=$1`,
        [externalId]
      )
      await page.reload()
      await expect(
        page.getByText(
          'The account’s credentials could not be verified. Reconnect it before publishing.'
        )
      ).toBeVisible()
      // The workspace accounts page reconnects through the account's own adapter too.
      await app.open('/settings/channels')
      await expect(
        page.getByRole('link', { name: 'Reconnect', exact: true }).first()
      ).toHaveAttribute(
        'href',
        `/integrations/social/x/start?socialSet=${created.id}&reconnect=${account?.id}`
      )
      await app.open(`/settings/publishing-brands/${created.id}`)
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Reconnect X account' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Connect X account', exact: true }).click()
      await expect(page).toHaveURL(/^https:\/\/api\.x\.com\/oauth\/authenticate/)
      const state = new URL(page.url()).searchParams.get('oauth_token') ?? ''
      await page.goto(xCallback(state))
      await expect(page).toHaveURL(
        new RegExp(`/settings/publishing-brands/${created.id}\\?connected=x$`)
      )
      await expect(page.getByText('Connected and ready to publish.')).toBeVisible()
      const after = (await sets()).find((set) => set.id === created.id)
      expect(after?.accounts.map((item) => [item.id, item.health])).toEqual([
        [account?.id, 'connected'],
      ])
    } finally {
      await cleanup()
    }
  }
)

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
} from './framework'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { blueskyConnectionCompleteResponseSchema } from '../../../../packages/screenshot-studio-backend-sdk/src/bluesky-connections'
import { socialSetListSchema } from '../../lib/api/contracts/social-sets'

// Synthetic provider credentials; this suite never contacts a real Bluesky PDS.
const password = 'abcd-efgh-ijkl-mnop'
const did = 'did:plc:abcdefghijklmnopqrstuvwx'

for (const outcome of ['verified', 'unknown'] as const) {
  test(
    `Bluesky ${outcome} connection keeps credentials single-use and the target durable`,
    { tag: '@journey' },
    async ({ app, browser, identity, page }) => {
      let organizationId: string | null = null
      const states: string[] = []
      const externalId = `bluesky-${randomUUID()}`
      const account = {
        id: externalId,
        provider: 'bluesky',
        nativeId: did,
        name: 'Disposable Bluesky',
        handle: 'fixture.bsky.social',
        avatarUrl: '',
        active: true,
        verifiedAt: new Date().toISOString(),
        verification: {
          accountKey: `bluesky:${did}`,
          accountKind: 'profile',
          grantedScopes: ['com.atproto.appPass'],
          capabilities: {
            version: 1,
            bluesky: {
              maxTextGraphemes: 300,
              maxTextBytes: 3000,
              maxImages: 4,
              imageMaxBytes: 2000000,
              maxVideos: 1,
              videoMaxBytes: 300000000,
              blobUploadLimit: null,
              videoCanUpload: null,
            },
          },
        },
      }
      const provider = await startHttpMockServer(async (request) => {
        if (request.url === '/api/public/v1/connection-availability')
          return { body: connectionAvailabilityFixture() }
        if (request.url === '/api/public/v1/me')
          return { body: { organization: { id: `go-${organizationId}` } } }
        if (request.url.startsWith('/api/public/v1/social/bluesky')) {
          const state = randomBytes(32).toString('base64url')
          states.push(state)
          return { body: { url: state } }
        }
        if (request.url === '/integrations/social-connect/bluesky') {
          if (outcome === 'unknown') return { status: 503, body: { error: 'provider unavailable' } }
          // This row belongs to the simulated adapter. The product's health check
          // reads it normally, without bypassing credential or tenant validation.
          await db.query(
            `INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token,"tokenExpiration","verifiedAccountKey","verifiedAccountKind","verifiedScopes","verifiedCapabilities","identityVerifiedAt")
           VALUES ($1,$2,$3,$4,'bluesky','social','fixture-only-credential',now()+interval '1 hour',$5,'profile',$6::jsonb,$7::jsonb,now())
           ON CONFLICT (id) DO UPDATE SET "tokenExpiration"=excluded."tokenExpiration"`,
            [
              externalId,
              did,
              `go-${organizationId}`,
              account.name,
              account.verification.accountKey,
              JSON.stringify(account.verification.grantedScopes),
              JSON.stringify(account.verification.capabilities),
            ]
          )
          return { body: { id: externalId } }
        }
        if (request.url === `/api/public/v1/integrations/${externalId}/identity`)
          return { body: account }
        if (request.url === '/api/public/v1/integrations')
          return { body: [{ id: externalId, identifier: 'bluesky', disabled: false }] }
        return { status: 404 }
      }, socialMockPort)
      const list = async () => {
        const response = await apiRequest(page, '/api/v1/social-sets')
        expect(response.status).toBe(200)
        return socialSetListSchema.parse(response.body).items
      }
      const exchanges = () =>
        provider.calls.filter((call) => call.url === '/integrations/social-connect/bluesky')
      try {
        await createWorkspace(identity, page)
        await enableTwoFactor(page, identity.password)
        organizationId = await bindTestGoOrganization(page)
        await db.query(
          `INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Bluesky fixture',now())`,
          [`go-${organizationId}`]
        )
        await app.open('/settings/publishing-brands?bluesky=preserve')
        const originalURL = page.url()
        await page.getByRole('button', { name: 'Add profile to your personal workspace' }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: 'Bluesky', exact: true }).click()
        await expect(dialog.getByRole('heading', { name: 'Connect Bluesky account' })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
        await dialog.getByLabel('Handle', { exact: true }).fill('@FIXTURE.BSKY.SOCIAL')
        await dialog.getByLabel('App Password', { exact: true }).fill('primary-password')
        await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled()
        await dialog.getByLabel('App Password', { exact: true }).fill(password)
        await expect(dialog.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Bluesky', exact: true })).toBeFocused()
        // Opening and cancelling only reads availability (the picker rechecks it); nothing connects.
        expect(new Set(provider.calls.map((call) => `${call.method} ${call.url}`))).toEqual(
          new Set(['GET /api/public/v1/me', 'GET /api/public/v1/connection-availability'])
        )
        expect(await list()).toHaveLength(0)
        expect(page.url()).toBe(originalURL)
        await dialog.getByRole('button', { name: 'Bluesky', exact: true }).click()
        await expect(dialog.getByLabel('App Password', { exact: true })).toHaveValue('')
        await expect(dialog.getByLabel('Handle', { exact: true })).toHaveValue('')
        await page.setViewportSize({ width: 390, height: 844 })
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true)
        await page.screenshot({
          path: `.context/bluesky-${outcome}-mobile.png`,
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1280, height: 800 })
        await dialog.getByLabel('Handle', { exact: true }).fill(' @FIXTURE.BSKY.SOCIAL ')
        await dialog.getByLabel('App Password', { exact: true }).fill(password)
        await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
        if (outcome === 'unknown') {
          await expect(dialog.getByRole('alert')).toContainText('result may be unknown')
          expect(await list()).toHaveLength(0)
          await expect(dialog.getByLabel('App Password', { exact: true })).toHaveCount(0)
          await dialog.getByRole('button', { name: 'Check connection result' }).click()
          await expect(dialog.getByRole('alert')).toContainText('result is unknown')
          await page.screenshot({
            path: '.context/bluesky-unknown-result.png',
            animations: 'disabled',
          })
        } else {
          await expect(dialog.getByText('Bluesky connected', { exact: true })).toBeVisible()
          expect(page.url()).toBe(originalURL)
          const sets = await list()
          expect(sets).toHaveLength(1)
          const created = sets[0]
          expect(created.visibility).toBe('PRIVATE')
          expect(created.accounts).toHaveLength(1)
          expect(created.accounts[0]).toMatchObject({
            platform: 'bluesky',
            health: 'connected',
            displayName: account.name,
            handle: account.handle,
          })
          const repeat = await apiRequest(page, '/api/v1/bluesky-connection-attempts/connect', {
            method: 'POST',
            body: { state: states[0] },
          })
          expect(repeat.status).toBe(200)
          expect(blueskyConnectionCompleteResponseSchema.parse(repeat.body).socialSetId).toBe(
            created.id
          )
          const anonymous = await browser.newContext()
          try {
            const response = await anonymous.request.post(
              getE2EUrl('/api/v1/bluesky-connection-attempts/connect'),
              { data: { state: states[0] } }
            )
            expect(response.status()).toBe(401)
            expect(await response.text()).not.toContain(account.handle)
          } finally {
            await anonymous.close()
          }
          await dialog.getByRole('link', { name: 'Open profile' }).click()
          await expect(page).toHaveURL(new RegExp(`/settings/publishing-brands/${created.id}$`))
          await app.reload()
          await expect(page.getByText(account.name, { exact: false }).first()).toBeVisible()
          await page.screenshot({
            path: '.context/bluesky-connected-account.png',
            animations: 'disabled',
          })
          await page.getByRole('button', { name: 'Add social account', exact: true }).click()
          await expect(
            dialog.getByRole('button', { name: 'Bluesky Connected', exact: true })
          ).toBeDisabled()
          await page.keyboard.press('Escape')
          const reconnectButton = page.getByRole('button', { name: 'Reconnect', exact: true })
          await expect(reconnectButton).toBeVisible()
          await reconnectButton.click()
          await expect(
            dialog.getByRole('heading', { name: 'Reconnect Bluesky account' })
          ).toBeVisible()
          await dialog.getByLabel('Handle', { exact: true }).fill(account.handle)
          await dialog.getByLabel('App Password', { exact: true }).fill(password)
          await dialog.getByRole('button', { name: 'Connect', exact: true }).click()
          await expect(dialog.getByText('Bluesky connected', { exact: true })).toBeVisible()
          expect((await list()).map((item) => item.id)).toEqual([created.id])
          expect((await list())[0].accounts[0].id).toBe(created.accounts[0].id)
          const reconnect = provider.calls.find((call) => call.url.includes('/social/bluesky?'))
          expect(new URL(reconnect?.url ?? '/', provider.url).searchParams.get('refresh')).toBe(did)
        }
        expect(exchanges()).toHaveLength(outcome === 'verified' ? 2 : 1)
        for (const call of exchanges()) {
          expect(call.method).toBe('POST')
          const payload = z
            .object({ code: z.string(), state: z.string() })
            .parse(JSON.parse(call.body))
          expect(states).toContain(payload.state)
          expect(JSON.parse(Buffer.from(payload.code, 'base64').toString('utf8'))).toEqual({
            identifier: account.handle,
            password,
          })
        }
        const storedBrowserState = await page.evaluate(() =>
          JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
        )
        expect(storedBrowserState).not.toContain(password)
        expect(page.url()).not.toContain(password)
        const rows = await db.query(
          'SELECT "exchangeStatus", "exchangeReceipt" FROM social_oauth_start WHERE state=$1',
          [states[0]]
        )
        const receipts = z
          .array(
            z.object({
              exchangeStatus: z.string(),
              exchangeReceipt: z
                .object({ account: z.object({ nativeId: z.string() }).optional() })
                .nullable(),
            })
          )
          .parse(rows.rows)
        expect(receipts).toHaveLength(1)
        expect(receipts[0].exchangeStatus).toBe(outcome === 'verified' ? 'COMPLETED' : 'EXCHANGING')
        if (outcome === 'verified') expect(receipts[0].exchangeReceipt?.account?.nativeId).toBe(did)
        expect(JSON.stringify(rows.rows)).not.toContain(password)
      } finally {
        await unbindTestGoOrganization(organizationId)
        await provider.close()
        if (organizationId) {
          await db.query('DELETE FROM "Integration" WHERE "organizationId"=$1', [
            `go-${organizationId}`,
          ])
          await db.query('DELETE FROM "Organization" WHERE id=$1', [`go-${organizationId}`])
        }
      }
    }
  )
}

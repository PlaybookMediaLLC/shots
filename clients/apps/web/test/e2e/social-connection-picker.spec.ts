import {
  apiRequest,
  bindTestGoOrganization,
  connectionAvailabilityFixture,
  createWorkspace,
  db,
  enableTwoFactor,
  expect,
  getE2EUrl,
  grantWorkspacePlan,
  socialMockPort,
  startHttpMockServer,
  test,
  unbindTestGoOrganization,
} from './framework'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { socialSetListSchema, socialSetSchema } from '../../lib/api/contracts/social-sets'

test(
  'provider-first creation stays layered, commits once, and preserves its set target',
  { tag: '@journey' },
  async ({ app, browser, context, identity, page }) => {
    let organizationId: string | null = null
    const state = randomUUID()
    const externalId = `picker-${randomUUID()}`
    const provider = await startHttpMockServer((request) => {
      if (request.url === '/api/public/v1/connection-availability')
        return { body: connectionAvailabilityFixture() }
      if (request.url === '/api/public/v1/me')
        return { body: { organization: { id: `go-${organizationId}` } } }
      if (request.url === '/api/public/v1/social/x')
        return { body: { url: `https://api.x.com/oauth/authenticate?oauth_token=${state}` } }
      if (request.url === '/integrations/social-connect/x')
        return { body: { id: externalId, pages: [] } }
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
            verification: {
              accountKey: 'x:123456789',
              accountKind: 'profile',
              grantedScopes: ['read-write'],
              capabilities: {
                version: 1,
                x: {
                  oauth1AccessLevel: 'read-write',
                  subscriptionType: null,
                  standardMaxWeightedCharacters: 280,
                  charactersReservedPerUrl: 23,
                  maxImages: 4,
                  maxGifs: 1,
                  maxVideos: 1,
                  imageMaxBytes: 5000000,
                  gifMaxBytes: 15000000,
                  longPostMaxWeightedCharacters: null,
                  videoMaxBytes: null,
                  videoMaxDurationSeconds: null,
                },
              },
            },
          },
        }
      if (request.url === '/api/public/v1/integrations')
        return { body: [{ id: externalId, identifier: 'x', disabled: false }] }
      return { status: 404 }
    }, socialMockPort)
    const list = async () => {
      const response = await apiRequest(page, '/api/v1/social-sets')
      expect(response.status).toBe(200)
      return socialSetListSchema.parse(response.body).items
    }
    try {
      await createWorkspace(identity, page)
      await enableTwoFactor(page, identity.password)
      organizationId = await bindTestGoOrganization(page)
      await app.open('/settings/publishing-brands?picker=preserve')
      await expect(page.getByText('No profiles yet', { exact: true })).toBeVisible()
      expect(await list()).toHaveLength(0)
      const originalURL = page.url()
      const launch = page.getByRole('button', {
        name: 'Add profile to your personal workspace',
      })
      await launch.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('heading', { name: 'Create a profile' })).toBeVisible()
      await expect(
        dialog.getByText('Private to you in this workspace', { exact: true })
      ).toBeVisible()
      await expect(dialog.getByRole('textbox')).toHaveCount(0)
      for (const label of [
        'X / Twitter',
        'LinkedIn',
        'Mastodon',
        'Threads',
        'Bluesky',
        'Substack Notes',
      ]) {
        await expect(dialog.getByRole('button', { name: label, exact: true })).toBeVisible()
      }
      for (const label of ['LinkedIn', 'Threads']) {
        await dialog.getByRole('button', { name: label, exact: true }).click()
        await expect(dialog.getByText(`You’ll go to ${label}`, { exact: false })).toBeVisible()
        await dialog.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(dialog.getByRole('button', { name: label, exact: true })).toBeFocused()
      }
      await expect(
        dialog.getByRole('button', { name: 'Substack Notes', exact: true })
      ).toBeDisabled()
      await expect(
        dialog.getByText('Substack Notes has no supported public publishing API.')
      ).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(launch).toBeFocused()
      expect(page.url()).toBe(originalURL)
      expect(await list()).toHaveLength(0)
      // Only readiness was read. In development React mounts the dialog twice, and
      // its first, aborted read can reach the provider too, so calls are compared as a set.
      expect([...new Set(provider.calls.map((call) => `${call.method} ${call.url}`))]).toEqual([
        'GET /api/public/v1/me',
        'GET /api/public/v1/connection-availability',
      ])

      // Authorization is a fixture page; no real provider account or credentials are used.
      await page.route('https://api.x.com/oauth/authenticate**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<main><h1>Fixture X authorization</h1></main>',
        })
      )
      await launch.click()
      await dialog.getByRole('button', { name: 'X / Twitter', exact: true }).click()
      await expect(dialog.getByRole('link', { name: 'Switch X account' })).toHaveAttribute(
        'href',
        'https://x.com/account/switch'
      )
      await page.screenshot({
        path: '.context/social-connection-picker.png',
        animations: 'disabled',
      })
      await dialog.getByRole('button', { name: 'Connect X account', exact: true }).click()
      await expect(page).toHaveURL(`https://api.x.com/oauth/authenticate?oauth_token=${state}`)
      expect(await list()).toHaveLength(0)

      const callback = getE2EUrl(
        `/integrations/social/x?oauth_token=${state}&oauth_verifier=fixture-verifier`
      )
      const completionURL = getE2EUrl(`/integrations/social/x/complete?state=${state}`)
      const pending = await context.request.get(completionURL)
      expect(await pending.text()).toContain('Connection confirmation unavailable')
      // Switch in another tab while the first tab is still at the provider.
      const otherTab = await context.newPage()
      try {
        await otherTab.goto('/settings/publishing-brands')
        const other = await apiRequest(otherTab, '/api/auth/organization/create', {
          method: 'POST',
          body: { name: 'Another product', slug: `callback-${randomUUID()}` },
        })
        expect(other.status).toBe(200)
        const otherId = z.object({ id: z.string() }).parse(other.body).id
        await grantWorkspacePlan(otherId, 'pro')
        expect(
          (
            await apiRequest(otherTab, `/api/v1/organizations/${otherId}/activate`, {
              method: 'POST',
            })
          ).status
        ).toBe(200)
        await page.goto(callback)
        await expect(page).toHaveURL(completionURL)
        await expect(
          page.getByRole('heading', { name: 'Connection completed', exact: true })
        ).toBeVisible()
        await expect(page.getByText(identity.workspaceName, { exact: true })).toBeVisible()
        expect(await list()).toHaveLength(0)
        await page.screenshot({
          path: '.context/social-connection-original-workspace.png',
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 390, height: 844 })
        await expect(
          page.getByRole('button', { name: `Open ${identity.workspaceName}`, exact: true })
        ).toBeVisible()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
        ).toBe(true)
        await page.screenshot({
          path: '.context/social-connection-original-workspace-mobile.png',
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1280, height: 720 })
        const anonymous = await browser.newContext()
        try {
          const hidden = await anonymous.request.get(completionURL)
          const html = await hidden.text()
          expect(html).toContain('Connection confirmation unavailable')
          expect(html).not.toContain(identity.workspaceName)
        } finally {
          await anonymous.close()
        }
        await page.getByRole('link', { name: 'Stay in the current workspace' }).click()
        expect(await list()).toHaveLength(0)
        await page.goto(callback)
        await page
          .getByRole('button', { name: `Open ${identity.workspaceName}`, exact: true })
          .click()
      } finally {
        await otherTab.close()
      }
      await expect(page).toHaveURL(/\/settings\/publishing-brands\/[a-z0-9]+\?connected=x$/)
      const sets = await list()
      expect(sets).toHaveLength(1)
      const created = socialSetSchema.parse(sets[0])
      expect(created.visibility).toBe('PRIVATE')
      expect(created.accounts).toHaveLength(1)
      expect(created.accounts[0]?.platform).toBe('x')
      await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('New profile')
      await page.getByRole('button', { name: 'Add social account', exact: true }).click()
      await expect(
        dialog.getByRole('heading', { name: 'Add account to “New profile”' })
      ).toBeVisible()
      await expect(
        dialog.getByRole('button', { name: 'X / Twitter Connected', exact: true })
      ).toBeDisabled()
      await expect(dialog.getByRole('button', { name: 'LinkedIn', exact: true })).toBeEnabled()
      await page.keyboard.press('Escape')
      await page.goto(callback)
      expect((await list()).map((item) => item.id)).toEqual([created.id])
      expect(
        provider.calls.filter((call) => call.url === '/integrations/social-connect/x')
      ).toHaveLength(1)
      const receipt = await db.query(
        'SELECT "exchangeStatus", "createdSocialSetId" FROM social_oauth_start WHERE state=$1',
        [state]
      )
      expect(
        z
          .array(
            z.object({
              exchangeStatus: z.literal('COMPLETED'),
              createdSocialSetId: z.literal(created.id),
            })
          )
          .parse(receipt.rows)
      ).toHaveLength(1)
    } finally {
      await unbindTestGoOrganization(organizationId)
      await provider.close()
    }
  }
)

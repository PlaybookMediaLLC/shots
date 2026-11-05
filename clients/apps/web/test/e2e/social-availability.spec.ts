import { connectionAvailabilitySchema } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
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
import { socialSetListSchema } from '../../lib/api/contracts/social-sets'

test('provider readiness fails closed, recovers, and rechecks before authorization', async ({
  app,
  browser,
  identity,
  page,
}) => {
  let organizationId: string | null = null
  let status = 503
  let catalog = connectionAvailabilityFixture({
    x: 'not_configured',
    bluesky: 'disabled',
    mastodon: 'not_configured',
    'mastodon-custom': 'disabled',
  })
  const provider = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/me')
      return { body: { organization: { id: `go-${organizationId}` } } }
    if (request.url === '/api/public/v1/connection-availability') return { status, body: catalog }
    if (request.url === '/api/public/v1/social/x')
      return { status: 503, body: { msg: 'Connection unavailable' } }
    return { status: 404 }
  }, socialMockPort)
  // In development React mounts the dialog twice, and its first, aborted read can
  // reach the provider too, so each step proves a fresh read rather than an exact count.
  const reads = () =>
    provider.calls.filter((call) => call.url === '/api/public/v1/connection-availability')
  let readsBefore = 0
  try {
    await createWorkspace(identity, page)
    await enableTwoFactor(page, identity.password)
    organizationId = await bindTestGoOrganization(page)
    await app.open('/settings/publishing-brands?availability=preserve')
    const originalURL = page.url()
    const launch = page.getByRole('button', {
      name: 'Add publishing brand to your personal workspace',
    })
    await launch.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('alert')).toContainText(
      'Connection availability could not be checked'
    )
    await expect(dialog.getByRole('button', { name: 'X / Twitter', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Bluesky', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    expect(reads().length).toBeGreaterThan(readsBefore)
    readsBefore = reads().length
    await page.screenshot({
      path: '.context/provider-availability-error.png',
      animations: 'disabled',
    })

    status = 200
    await dialog.getByRole('button', { name: 'Check again' }).click()
    const x = dialog.getByRole('button', { name: 'X / Twitter', exact: true })
    await expect(x).toBeDisabled()
    await expect(x).toHaveAccessibleDescription('Connection setup is not complete yet.')
    await expect(dialog.getByRole('button', { name: 'LinkedIn', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: 'Substack Notes', exact: true })).toBeDisabled()
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    expect(reads().length).toBeGreaterThan(readsBefore)
    readsBefore = reads().length
    await page.screenshot({
      path: '.context/provider-availability-disabled.png',
      animations: 'disabled',
    })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: '.context/provider-availability-mobile.png',
      animations: 'disabled',
    })

    // Reopening reads current configuration; no provider credentials are cached in the dialog.
    await page.keyboard.press('Escape')
    await expect(launch).toBeFocused()
    catalog = connectionAvailabilityFixture()
    await launch.click()
    await expect(x).toBeEnabled()
    expect(reads().length).toBeGreaterThan(readsBefore)
    await x.click()
    await expect(dialog.getByRole('link', { name: 'Switch X account' })).toBeVisible()
    // The adapter now refuses the start, simulating configuration disabled after the read.
    await dialog.getByRole('button', { name: 'Connect X account', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Connect X account', exact: true })
    ).toBeEnabled()
    expect(page.url()).toBe(originalURL)
    expect(provider.calls.filter((call) => call.url === '/api/public/v1/social/x')).toHaveLength(1)
    expect(provider.calls.every((call) => call.method === 'GET' && call.body === '')).toBe(true)
    const sets = await apiRequest(page, '/api/v1/social-sets')
    expect(sets.status).toBe(200)
    expect(socialSetListSchema.parse(sets.body).items).toHaveLength(0)
    const attempts = await db.query(
      'SELECT count(*)::int AS count FROM social_oauth_start WHERE "organizationId"=$1',
      [organizationId]
    )
    expect(z.array(z.object({ count: z.number() })).parse(attempts.rows)).toEqual([{ count: 0 }])

    const response = await page.request.get(getE2EUrl('/api/v1/social-connection-availability'))
    expect(response.status()).toBe(200)
    expect(response.headers()['cache-control']).toContain('no-store')
    expect(
      connectionAvailabilitySchema
        .parse(await response.json())
        .providers.find((item) => item.provider === 'x')?.status
    ).toBe('available')
    const before = reads().length
    expect(
      (await apiRequest(page, '/api/v1/social-connection-availability?organizationId=another'))
        .status
    ).toBe(400)
    const anonymous = await browser.newContext()
    try {
      expect(
        (await anonymous.request.get(getE2EUrl('/api/v1/social-connection-availability'))).status()
      ).toBe(401)
    } finally {
      await anonymous.close()
    }
    expect(reads()).toHaveLength(before)
    // There is no free plan: without a subscription, readiness is refused before any provider read.
    await grantWorkspacePlan(organizationId, 'free')
    expect((await apiRequest(page, '/api/v1/social-connection-availability')).status).toBe(403)
    expect(reads()).toHaveLength(before)
  } finally {
    await unbindTestGoOrganization(organizationId)
    await provider.close()
  }
})

import {
  apiRequest,
  bindTestGoOrganization,
  chooseOption,
  connectionAvailabilityFixture,
  createWorkspace,
  enableTwoFactor,
  expect,
  getE2EUrl,
  socialMockPort,
  startHttpMockServer,
  test,
  unbindTestGoOrganization,
} from './framework'
import { randomUUID } from 'node:crypto'
import { socialOAuthBeginRequestSchema } from 'screenshot-studio-backend-sdk'
import { socialSetListSchema } from '../../lib/api/contracts/social-sets'

test('custom Mastodon authorization keeps the selected origin and commits one private set', async ({
  app,
  identity,
  page,
}) => {
  test.skip(
    process.env.PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED !== 'true',
    'Requires the opt-in adapter on the local product API.'
  )
  let organizationId: string | null = null
  const state = randomUUID()
  const externalId = `mastodon-fixture-${randomUUID()}`
  const provider = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/connection-availability')
      return { body: connectionAvailabilityFixture() }
    if (request.url === '/api/public/v1/me')
      return { body: { organization: { id: `go-${organizationId}` } } }
    const url = new URL(request.url, 'http://fixture.test')
    if (url.pathname === '/api/public/v1/social/mastodon-custom') {
      expect(url.searchParams.get('instance')).toBe('https://social.example')
      return { body: { url: `https://social.example/oauth/authorize?state=${state}` } }
    }
    if (request.url === '/integrations/social-connect/mastodon-custom')
      return { body: { id: externalId, pages: [] } }
    if (request.url === '/api/public/v1/integrations')
      return { body: [{ id: externalId, identifier: 'mastodon-custom', disabled: false }] }
    return { status: 404 }
  }, socialMockPort)
  try {
    await createWorkspace(identity, page)
    await enableTwoFactor(page, identity.password)
    organizationId = await bindTestGoOrganization(page)
    // Only the remote metadata and provider protocol are fixtures. Ownership commits in Go/Postgres.
    await page.route('**/api/v1/social-instances/mastodon?*', (route) => {
      const server = new URL(route.request().url()).searchParams.get('server')
      return route.fulfill({
        json: {
          origin: `https://${server}`,
          title: 'Disposable protocol fixture',
          description: 'No real provider credentials',
          activeUsers: 12,
          authorizationEnabled: true,
        },
      })
    })
    await page.route('https://social.example/oauth/authorize**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Fixture Mastodon authorization</h1>' })
    )
    await app.open('/settings/publishing-brands')
    await page
      .getByRole('button', { name: 'Add publishing brand to your personal workspace' })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Mastodon', exact: true }).click()
    await chooseOption(dialog.getByRole('combobox', { name: 'Mastodon server' }), /^Custom server/)
    const connect = dialog.getByRole('button', { name: 'Connect Mastodon account', exact: true })
    await expect(connect).toBeDisabled()
    await dialog.getByLabel('Custom server hostname').fill('social.example')
    await expect(connect).toBeEnabled()
    const outgoing = page.waitForRequest((request) =>
      request.url().endsWith('/api/v1/social-connection-attempts')
    )
    await connect.click()
    const body = socialOAuthBeginRequestSchema.parse((await outgoing).postDataJSON())
    expect(body).toMatchObject({
      provider: 'mastodon-custom',
      instanceServer: 'social.example',
      operation: 'CREATE_SET',
      creationVisibility: 'PRIVATE',
    })
    await expect(page).toHaveURL(`https://social.example/oauth/authorize?state=${state}`)
    expect(
      socialSetListSchema.parse((await apiRequest(page, '/api/v1/social-sets')).body).items
    ).toHaveLength(0)
    const callback = getE2EUrl(
      `/integrations/social/mastodon-custom?state=${state}&code=fixture-code`
    )
    await page.goto(callback)
    await expect(page).toHaveURL(/connected=mastodon-custom$/)
    const items = socialSetListSchema.parse(
      (await apiRequest(page, '/api/v1/social-sets')).body
    ).items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      visibility: 'PRIVATE',
      defaultPlatforms: ['mastodon'],
      primaryPlatform: 'mastodon',
      accounts: [{ platform: 'mastodon-custom' }],
    })
    await app.reload()
    await page.goto(callback)
    const repeated = socialSetListSchema.parse(
      (await apiRequest(page, '/api/v1/social-sets')).body
    ).items
    expect(repeated.map((set) => set.id)).toEqual(items.map((set) => set.id))
    expect(
      provider.calls.filter((call) => call.url === '/integrations/social-connect/mastodon-custom')
    ).toHaveLength(1)
    await expect(page.getByLabel('Publishing brand name', { exact: true })).toHaveValue('New brand')
    await page.screenshot({
      path: '.context/mastodon-connection-fixture.png',
      animations: 'disabled',
    })
  } finally {
    await unbindTestGoOrganization(organizationId)
    await provider.close()
  }
})

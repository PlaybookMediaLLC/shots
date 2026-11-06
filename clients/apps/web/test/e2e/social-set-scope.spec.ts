import {
  bindTestGoOrganization,
  browserJson,
  browserRequest,
  connectionAvailabilityFixture,
  enableTwoFactor,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  socialMockPort,
  startHttpMockServer,
  test,
  unbindTestGoOrganization,
} from './framework'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { socialSetSchema } from '../../lib/api/contracts/social-sets'
import { workspaceScopeHeaders } from '../../lib/auth/request-scope'

test(
  'private social-set caches and delayed mutations stay in their original workspace',
  { tag: '@journey' },
  async ({ app, context, identity, page }) => {
    await signUpViaApi(identity, page)
    expect(
      (
        await requestJson(page, '/api/auth/sign-in/email', {
          email: identity.email,
          password: identity.password,
        })
      ).status
    ).toBe(200)
    const person = z
      .object({ user: z.object({ id: z.string() }) })
      .parse(await browserJson(page, '/api/auth/get-session')).user
    const createWorkspace = async (name: string) => {
      const workspace = z.object({ id: z.string() }).parse(
        await browserJson(page, '/api/auth/organization/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: `${name} workspace`, slug: `scope-${randomUUID()}` }),
        })
      )
      await grantWorkspacePlan(workspace.id, 'pro')
      expect(
        (
          await requestJson(page, '/api/auth/organization/set-active', {
            organizationId: workspace.id,
          })
        ).status
      ).toBe(200)
      const set = socialSetSchema.parse(
        await browserJson(page, '/api/v1/social-sets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, visibility: 'PRIVATE' }),
        })
      )
      await browserJson(page, `/api/v1/social-sets/${set.id}/writing-samples`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Private writing sample for ${name}. Keep this workspace's stories together.`,
        }),
      })
      return { workspace, set }
    }
    const alpha = await createWorkspace('Private Alpha')
    const beta = await createWorkspace('Private Beta')
    expect(
      (
        await requestJson(page, '/api/auth/organization/set-active', {
          organizationId: alpha.workspace.id,
        })
      ).status
    ).toBe(200)
    await enableTwoFactor(page, identity.password)
    await bindTestGoOrganization(page)
    const provider = await startHttpMockServer((request) => {
      if (request.url === '/api/public/v1/connection-availability')
        return { body: connectionAvailabilityFixture() }
      if (request.url === '/api/public/v1/me')
        return { body: { organization: { id: `go-${alpha.workspace.id}` } } }
      if (request.url === '/api/public/v1/social/x')
        return { body: { url: `https://api.x.com/oauth/authenticate?oauth_token=${randomUUID()}` } }
      return { status: 404 }
    }, socialMockPort)
    const loadAlpha = page.waitForRequest(
      (request) => request.url().endsWith('/api/v1/social-sets') && request.method() === 'GET'
    )
    await app.open('/settings/publishing-brands')
    await expect(
      page.getByRole('link', { name: 'Settings for Private Alpha', exact: true })
    ).toBeVisible()
    const headers = (await loadAlpha).headers()
    expect(headers['x-playbook-user']).toBe(person.id)
    expect(headers['x-playbook-workspace']).toBe(alpha.workspace.id)
    await expect(
      page.getByRole('link', { name: 'Settings for Private Beta', exact: true })
    ).toHaveCount(0)

    // An attempt may persist before another tab switches the workspace. Hold
    // its response to prove the old caller cannot navigate to provider authorization.
    let releaseResponse = () => {}
    let recordCommit = () => {}
    let recordDelivery = () => {}
    const heldResponse = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    const committed = new Promise<void>((resolve) => {
      recordCommit = resolve
    })
    const delivered = new Promise<void>((resolve) => {
      recordDelivery = resolve
    })
    await page.route('**/api/v1/social-connection-attempts', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      recordCommit()
      await heldResponse
      try {
        await route.fulfill({ response })
      } finally {
        recordDelivery()
      }
    })
    await page.getByRole('button', { name: 'Add profile to your personal workspace' }).click()
    await page.getByRole('button', { name: 'X / Twitter', exact: true }).click()
    const cancelledCreation = page.waitForEvent(
      'requestfailed',
      (request) =>
        request.method() === 'POST' && request.url().endsWith('/api/v1/social-connection-attempts')
    )
    await page.getByRole('button', { name: 'Connect X account', exact: true }).click()
    await committed

    const sibling = await context.newPage()
    try {
      await sibling.goto('/settings/publishing-brands')
      expect(
        (
          await requestJson(sibling, '/api/auth/organization/set-active', {
            organizationId: beta.workspace.id,
          })
        ).status
      ).toBe(200)
      const stale = await browserRequest(page, `/api/v1/social-sets/${alpha.set.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...workspaceScopeHeaders({ userId: person.id, workspaceId: alpha.workspace.id }),
        },
        body: JSON.stringify({ baseVersion: alpha.set.version, name: 'Wrong workspace save' }),
      })
      expect(stale.status).toBe(403)
      expect(JSON.stringify(stale.body)).not.toContain('Private Beta')
      const wrongPerson = await browserRequest(page, '/api/v1/social-sets', {
        headers: workspaceScopeHeaders({
          userId: 'another-person',
          workspaceId: beta.workspace.id,
        }),
      })
      expect(wrongPerson.status).toBe(403)

      // Refocusing replaces the private cache under the workspace-switch guard,
      // without reloading the page or leaving the old connection dialog open.
      await page.bringToFront()
      await expect(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await expect(
          page.getByRole('link', {
            name: 'Settings for Private Beta',
            exact: true,
            includeHidden: true,
          })
        ).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 30_000, intervals: [1_000, 5_000] })
      await expect(
        page.getByRole('link', {
          name: 'Settings for Private Alpha',
          exact: true,
          includeHidden: true,
        })
      ).toHaveCount(0)
      await expect(page.getByTestId('workspace-banner')).toContainText(
        'You switched to Private Beta workspace in another tab'
      )
      await cancelledCreation
      releaseResponse()
      await delivered
      await expect(page).toHaveURL(/\/settings\/publishing-brands$/)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(
        page.getByRole('link', { name: 'Settings for Delayed Alpha creation', exact: true })
      ).toHaveCount(0)
      // This tab's own requests are refused until the person chooses, so read past it.
      const storedBeta = socialSetSchema.parse(
        await (await context.request.get(`/api/v1/social-sets/${beta.set.id}`)).json()
      )
      expect(storedBeta.name).toBe('Private Beta')
      expect(
        (
          await requestJson(sibling, '/api/auth/organization/set-active', {
            organizationId: alpha.workspace.id,
          })
        ).status
      ).toBe(200)
      const storedAlpha = socialSetSchema.parse(
        await browserJson(sibling, `/api/v1/social-sets/${alpha.set.id}`)
      )
      expect(storedAlpha.name).toBe('Private Alpha')
      await page.bringToFront()
      await expect(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await expect(
          page.getByRole('link', { name: 'Settings for Private Alpha', exact: true })
        ).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 30_000, intervals: [1_000, 5_000] })
      await expect(
        page.getByRole('link', { name: 'Settings for Private Beta', exact: true })
      ).toHaveCount(0)
      await page.getByRole('link', { name: 'Settings for Private Alpha', exact: true }).click()
      await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue('Private Alpha')
      await page.getByLabel('Profile name', { exact: true }).fill('Private Alpha saved')
      await page.getByLabel('Profile name', { exact: true }).press('Enter')
      await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
      await app.reload()
      await expect(page.getByLabel('Profile name', { exact: true })).toHaveValue(
        'Private Alpha saved'
      )
      await app.open(`/settings/publishing-brands/${alpha.set.id}/writing-assistant`)
      await expect(
        page
          .locator('[data-slot="disclosure-trigger"]')
          .filter({ hasText: 'Private writing sample for Private Alpha.' })
      ).toBeVisible()
      await page.screenshot({
        path: '.context/social-set-scoped-settings.png',
        animations: 'disabled',
      })
    } finally {
      releaseResponse()
      await sibling.close()
      await provider.close()
      await unbindTestGoOrganization(alpha.workspace.id)
    }
  }
)

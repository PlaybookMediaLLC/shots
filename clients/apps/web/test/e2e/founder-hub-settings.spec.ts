import { randomUUID } from 'node:crypto'
import {
  founderHubDeviceSchema,
  founderHubSettingsSchema,
  founderHubTemplatePageSchema,
} from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { db, expect, getE2EUrl, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const report = {
  platform: 'linux',
  version: 'test',
  identifier: 'settings-test',
  locale: 'en',
  timezone: 'UTC',
  appStore: false,
  supportsSettingsNavigation: true,
  lockAvailable: false,
  homeDirectory: '',
  downloadsDirectory: '',
  microphones: [],
  installedApps: [],
  defaultIgnoredApps: [],
  permissions: {},
}

test('Founder Hub preferences persist in Shots and reject stale or browser lock writes', async ({
  app,
  page,
  request,
}) => {
  await app.open('/settings/founder-hub/appearance')
  const light = page.getByRole('radio', { name: 'Light Bright canvas' })
  await light.click()
  await expect(light).toBeChecked()
  await app.reload()
  await expect(light).toBeChecked()
  const snapshot = founderHubSettingsSchema.parse(
    await (await page.request.get(getE2EUrl('/api/founder-hub/settings'))).json()
  )
  const profile = snapshot.profiles.find((entry) => entry.deviceId === '')!
  const patch = {
    deviceId: '',
    deviceName: '',
    baseVersion: profile.version,
    values: { use_24_hour_time: true },
  }
  expect(
    (await page.request.patch(getE2EUrl('/api/founder-hub/settings'), { data: patch })).status()
  ).toBe(200)
  expect(
    (
      await page.request.patch(getE2EUrl('/api/founder-hub/settings'), {
        data: { ...patch, values: { theme: 'dark' } },
      })
    ).status()
  ).toBe(409)
  await app.reload()
  await expect(light).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Use 24-hour time' })).toBeChecked()
  expect(
    (
      await page.request.patch(getE2EUrl('/api/founder-hub/settings'), {
        data: {
          deviceId: 'test-desktop',
          deviceName: '',
          baseVersion: 0,
          values: { lock_app: false },
        },
      })
    ).status()
  ).toBe(403)
  expect((await request.get(getE2EUrl('/api/founder-hub/settings'))).status()).toBe(401)
})

test('workspace Founder Hub settings and referrals work without a connected desktop', async ({
  app,
  page,
}) => {
  expect(await (await page.request.get(getE2EUrl('/api/founder-hub/devices'))).json()).toEqual([])
  const referrals = await page.request.get(getE2EUrl('/api/founder-hub/referrals'))
  expect(referrals.status()).toBe(200)
  let referralsEnabled = true
  await page.route('**/api/founder-hub/referrals', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: referralsEnabled,
        eligible: false,
        code: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        accepted: 0,
        remaining: 1,
        months_earned: 0,
        invites: [],
      }),
    })
  )
  await page.route('**/api/founder-hub/referrals/claim', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ claimed: false }) })
  )
  await app.open('/settings/founder-hub/referrals')
  await expect(page.getByRole('heading', { name: 'Referrals' })).toBeVisible()
  await expect(
    page.getByText('Invite friends and track referral rewards for your Shots account.')
  ).toBeVisible()
  await page.getByLabel('Claim a referral code').fill('bbbbbbbbbbbbbbbbbbbbbbbb')
  await page.getByRole('button', { name: 'Claim' }).click()
  await expect(
    page.getByText('This referral code cannot be claimed by this account.', { exact: true })
  ).toBeVisible()
  referralsEnabled = false
  await app.reload()
  await expect(
    page.getByText('Referrals are not available in this Shots environment yet.', { exact: true })
  ).toBeVisible()
  await expect(page.getByLabel('Claim a referral code')).toHaveCount(0)

  await app.open('/settings/founder-hub/billing')
  await expect(page.getByText('Plan and credits')).toBeVisible()
  await expect(page.locator('fieldset').last()).toBeEnabled()

  await app.open('/settings/founder-hub/developers')
  await expect(page.getByText('Organization API keys')).toBeVisible()
  await expect(page.locator('fieldset').last()).toBeEnabled()

  await app.open('/settings/founder-hub/crm')
  await expect(page.getByRole('heading', { name: 'CRM' })).toBeVisible()
  for (const provider of ['HubSpot', 'Attio', 'Salesforce', 'Pipedrive', 'Close']) {
    await expect(page.getByRole('heading', { name: provider, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: `Connect ${provider}` })).toBeDisabled()
  }
  await expect(
    page.getByText('CRM providers are not configured for this Shots environment.')
  ).toBeVisible()

  await app.open('/settings/founder-hub/imports')
  await expect(page.getByRole('heading', { name: 'Imports' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open imports on desktop' })).toBeDisabled()

  await app.open('/settings/founder-hub/intelligence')
  await expect(page.getByRole('heading', { name: 'Model catalog and sign-in' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open model settings on desktop' })).toBeDisabled()
})

test('native-only settings navigation requires a capable desktop and queues a bounded command', async ({
  app,
  page,
  identity,
}) => {
  const deviceId = `settings-nav-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  const { supportsSettingsNavigation: _navigationCapability, ...legacyReport } = report
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report)
    SELECT $1,id,$2,'Legacy settings desktop',$3 FROM "user" WHERE email=$4`,
    [randomUUID(), deviceId, legacyReport, identity.email]
  )
  await app.open('/settings/founder-hub/imports')
  const openImports = page.getByRole('button', { name: 'Open imports on desktop' })
  await expect(openImports).toBeDisabled()

  await db.query(
    `UPDATE platform_founder_hub_device SET report=$2 WHERE "userId"=(SELECT id FROM "user" WHERE email=$1) AND "deviceId"=$3`,
    [identity.email, report, deviceId]
  )
  const devicesResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/founder-hub/devices')
  )
  await app.reload()
  const updatedDevices = z.array(founderHubDeviceSchema).parse(await (await devicesResponse).json())
  expect(
    updatedDevices.find((device) => device.deviceId === deviceId)?.report.supportsSettingsNavigation
  ).toBe(true)
  await expect(openImports).toBeEnabled()

  let commandInput: unknown
  const command = {
    id: 'settings-navigation-test',
    deviceId,
    kind: 'open-settings-page',
    argument: 'imports',
    status: 'succeeded',
    error: '',
    result: '',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  await page.route('**/api/founder-hub/devices/commands', async (route) => {
    commandInput = route.request().postDataJSON()
    await route.fulfill({ json: command })
  })
  await page.route('**/api/founder-hub/devices/commands/*', (route) =>
    route.fulfill({ json: command })
  )
  await openImports.click()
  await expect
    .poll(() => commandInput)
    .toMatchObject({
      deviceId,
      kind: 'open-settings-page',
      argument: 'imports',
    })
})

test('Founder Hub Insights renders ranges, ignores stale commands, and shows command failures', async ({
  app,
  page,
  identity,
}) => {
  const deviceId = 'insights-test'
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report)
    SELECT $1,id,$2,'Insights test desktop',$3 FROM "user" WHERE email=$4`,
    [randomUUID(), deviceId, report, identity.email]
  )

  const commands = new Map<string, Record<string, unknown>>()
  let commandNumber = 0
  let failNextCommand = false
  let releaseInitialCommand: () => void = () => {}
  const initialCommandGate = new Promise<void>((resolve) => {
    releaseInitialCommand = resolve
  })
  await page.route('**/api/founder-hub/devices/commands', async (route) => {
    const input = route.request().postDataJSON() as { argument: 'all' | '30d' | '7d' }
    const number = ++commandNumber
    if (failNextCommand) {
      failNextCommand = false
      return route.fulfill({ status: 503, json: { message: 'Insights command failed' } })
    }
    const id = `insights-command-${number}`
    const summary =
      input.argument === 'all'
        ? {
            conversations: 7,
            totalConversations: 7,
            hours: 2,
            activeDays: 5,
            streak: 2,
            days: [{ key: '2026-11-09', count: 2 }],
            weekdayCounts: [1, 2, 3, 4, 5, 6, 0].map((weekday, index) => ({
              weekday,
              count: 7 - index,
            })),
          }
        : {
            conversations: 0,
            totalConversations: 7,
            hours: 0,
            activeDays: 0,
            streak: 2,
            days: [{ key: '2026-11-09', count: 2 }],
            weekdayCounts: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({ weekday, count: 0 })),
          }
    const command = {
      id,
      deviceId,
      kind: 'activity-insights',
      argument: input.argument,
      status: 'succeeded',
      error: '',
      result: JSON.stringify(summary),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    commands.set(id, command)
    if (number === 1) await initialCommandGate
    await route.fulfill({ json: command })
  })
  await page.route('**/api/founder-hub/devices/commands/*', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!
    const command = commands.get(id)
    if (!command) return route.fulfill({ status: 404 })
    await route.fulfill({ json: command })
  })

  const commandCreated = (argument: 'all' | '7d') =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/founder-hub/devices/commands') &&
        response.request().method() === 'POST' &&
        (response.request().postDataJSON() as { argument: string }).argument === argument
    )
  const firstCommandCreated = commandCreated('all')
  await app.open('/settings/founder-hub/insights')
  await expect.poll(() => commandNumber).toBe(1)
  await page.getByRole('combobox', { name: 'Insights date range' }).click()
  const secondCommandCreated = commandCreated('7d')
  await page.getByRole('option', { name: 'Last 7 days' }).click()
  await secondCommandCreated
  const emptyRangeMessage = page.getByText('No conversations in this date range.')
  await expect(emptyRangeMessage).toBeVisible()
  releaseInitialCommand()
  await firstCommandCreated
  await expect(emptyRangeMessage).toBeVisible()

  await page.getByRole('combobox', { name: 'Insights date range' }).click()
  const thirdCommandCreated = commandCreated('all')
  await page.getByRole('option', { name: 'All time' }).click()
  await thirdCommandCreated
  const weekdaySection = page.getByRole('region', { name: 'Conversations by weekday' })
  const weekdayRows = weekdaySection.getByRole('listitem')
  await expect(weekdayRows).toHaveCount(7)
  await expect(weekdayRows.nth(0)).toContainText('Monday')
  await expect(weekdayRows.nth(0)).toContainText('7')
  await expect(weekdayRows.nth(6)).toContainText('Sunday')
  await expect(weekdayRows.nth(6)).toContainText('1')

  failNextCommand = true
  const failedCommand = commandCreated('all')
  const refresh = page.getByRole('button', { name: 'Refresh' })
  await refresh.click()
  expect((await failedCommand).status()).toBe(503)
  await expect(page.getByRole('alert').filter({ hasText: 'Insights command failed' })).toBeVisible()
  await expect(refresh).toBeEnabled()
})

test('a failed Founder Hub dictionary save retains the draft for retry', async ({
  app,
  page,
  identity,
}) => {
  // Only capability data is seeded; sign-in, persistence and authorization use the real backend.
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report)
    SELECT $1,id,'settings-test','Settings test desktop',$2 FROM "user" WHERE email=$3`,
    [randomUUID(), report, identity.email]
  )
  await app.open('/settings/founder-hub/dictionary')
  const field = page.getByPlaceholder('Add names, jargon, or product terms to prefer')
  await field.fill('Founder Hub regression term')
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report)
    SELECT $1,id,'new-device','A newly connected desktop',$2 FROM "user" WHERE email=$3`,
    [randomUUID(), report, identity.email]
  )
  await page.waitForResponse((response) => response.url().endsWith('/api/founder-hub/devices'))
  await expect(page.getByRole('combobox', { name: 'Computer settings' })).toHaveText(
    'Settings test desktop'
  )
  await expect(field).toHaveValue('Founder Hub regression term')
  await page.route('**/api/founder-hub/settings', (route) => route.abort('failed'))
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'Not all changes were saved' })
  ).toBeVisible()
  await expect(field).toHaveValue('Founder Hub regression term')
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your draft is still here' })
  ).toBeVisible()
  await expect(field).toHaveValue('Founder Hub regression term')
  await page.unroute('**/api/founder-hub/settings')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(field).toHaveValue('')
  await app.reload()
  await page.getByRole('combobox', { name: 'Computer settings' }).click()
  await page.getByRole('option', { name: 'Settings test desktop', exact: true }).click()
  await expect(page.getByText('Founder Hub regression term', { exact: true })).toBeVisible()
})

test('native action failures and expired commands release the settings controls', async ({
  app,
  page,
  identity,
}) => {
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report)
    SELECT $1,id,'command-test','Command test desktop',$2 FROM "user" WHERE email=$3`,
    [randomUUID(), report, identity.email]
  )
  await app.open('/settings/founder-hub/general')
  await page.route('**/api/founder-hub/devices/commands/*', (route) => route.abort('failed'))
  const releaseNotes = page.getByRole('button', { name: 'Show release notes' })
  await releaseNotes.click()
  await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
  await expect(releaseNotes).toBeEnabled()
  await page.unroute('**/api/founder-hub/devices/commands/*')
  await page.clock.install()
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/founder-hub/devices/commands') &&
      response.request().method() === 'POST'
  )
  await releaseNotes.click()
  const command = await (await created).json()
  await page.clock.setSystemTime(new Date(Date.parse(command.expiresAt) + 1000))
  await page.clock.runFor(1001)
  await expect(page.getByRole('alert').filter({ hasText: 'This request expired' })).toBeVisible()
  await expect(releaseNotes).toBeEnabled()
})

test('Founder Hub templates preserve editable sections and drafts when a save fails', async ({
  app,
  page,
}) => {
  await app.open('/settings/founder-hub/templates')
  await page.getByRole('button', { name: 'Create template', exact: true }).click()
  const title = page.getByRole('textbox', { name: 'Template title', exact: true })
  await expect(title).toHaveValue('New Template')
  const templateName = `Founder review ${randomUUID().slice(0, 8)}`
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/founder-hub/templates/') &&
      response.request().method() === 'PATCH' &&
      response.status() === 200
  )
  await title.fill(templateName)
  await saved
  await page.getByRole('button', { name: 'Add Section', exact: true }).click()
  const section = page.getByRole('textbox', { name: 'Section 1 title', exact: true })
  await section.fill('Decisions')
  await expect
    .poll(async () => {
      const library = founderHubTemplatePageSchema.parse(
        await (await page.request.get(getE2EUrl('/api/founder-hub/templates'))).json()
      )
      return library.items.find((item) => item.title === templateName)?.sections[0]?.title
    })
    .toBe('Decisions')
  await app.reload()
  await page.getByRole('button', { name: templateName, exact: true }).click()
  await expect(section).toHaveValue('Decisions')
  await page.route('**/api/founder-hub/templates/*', (route) =>
    route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()
  )
  await title.fill('Unsaved founder draft')
  await expect(page.getByText('Failed to fetch', { exact: false }).first()).toBeVisible()
  await expect(title).toHaveValue('Unsaved founder draft')
  await page.getByRole('button', { name: 'Auto', exact: true }).click()
  await page.getByRole('button', { name: templateName, exact: true }).click()
  await expect(title).toHaveValue('Unsaved founder draft')
  await page.unroute('**/api/founder-hub/templates/*')
  await title.fill(`${templateName} recovered`)
  await expect
    .poll(async () => {
      const library = founderHubTemplatePageSchema.parse(
        await (await page.request.get(getE2EUrl('/api/founder-hub/templates'))).json()
      )
      return library.items.some((item) => item.title === `${templateName} recovered`)
    })
    .toBe(true)
  await page.route('**/api/founder-hub/templates/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await route.fetch()
    await route.abort('failed')
  })
  await title.fill(`${templateName} response lost`)
  await expect
    .poll(async () =>
      founderHubTemplatePageSchema
        .parse(await (await page.request.get(getE2EUrl('/api/founder-hub/templates'))).json())
        .items.some((item) => item.title === `${templateName} response lost`)
    )
    .toBe(true)
  await expect(page.getByText('Failed to fetch', { exact: false }).first()).toBeVisible()
  await page.unroute('**/api/founder-hub/templates/*')
  await title.fill(`${templateName} response recovered`)
  await expect
    .poll(async () =>
      founderHubTemplatePageSchema
        .parse(await (await page.request.get(getE2EUrl('/api/founder-hub/templates'))).json())
        .items.some((item) => item.title === `${templateName} response recovered`)
    )
    .toBe(true)

  await page.route('**/api/founder-hub/templates/*', (route) =>
    route.request().method() === 'PATCH' ? route.abort('failed') : route.continue()
  )
  await title.fill('Keep my deleted-template draft')
  await expect(page.getByText('Failed to fetch', { exact: false }).first()).toBeVisible()
  const library = founderHubTemplatePageSchema.parse(
    await (await page.request.get(getE2EUrl('/api/founder-hub/templates'))).json()
  )
  const current = library.items.find((item) => item.title === `${templateName} response recovered`)!
  expect(
    (
      await page.request.patch(getE2EUrl(`/api/founder-hub/templates/${current.id}`), {
        data: { baseVersion: current.version, deleted: true },
      })
    ).status()
  ).toBe(200)
  await expect(
    page.getByText('This template was deleted elsewhere. Your unsaved draft is still here.')
  ).toBeVisible({ timeout: 20000 })
  await expect(title).toHaveValue('Keep my deleted-template draft')
  await page.unroute('**/api/founder-hub/templates/*')
  await page.getByRole('button', { name: 'Save as copy', exact: true }).click()
  await expect(title).toHaveValue('Keep my deleted-template draft (Copy)')
  await expect(section).toHaveValue('Decisions')
})

test('a polled summary format change cannot overwrite an existing Auto draft', async ({
  app,
  page,
  identity,
}) => {
  await db.query(
    `INSERT INTO platform_founder_hub_device (id,"userId","deviceId",name,report) SELECT $1,id,'auto-test','Auto test desktop',$2 FROM "user" WHERE email=$3`,
    [randomUUID(), report, identity.email]
  )
  await app.open('/settings/founder-hub/templates')
  const format = page.getByRole('textbox', { name: 'Auto summary format' })
  await format.fill('My unsaved format')
  const snapshot = founderHubSettingsSchema.parse(
    await (await page.request.get(getE2EUrl('/api/founder-hub/settings'))).json()
  )
  const current = snapshot.profiles.find((profile) => profile.deviceId === 'auto-test')
  expect(
    (
      await page.request.patch(getE2EUrl('/api/founder-hub/settings'), {
        data: {
          deviceId: 'auto-test',
          deviceName: 'Auto test desktop',
          baseVersion: current?.version ?? 0,
          values: { auto_summary_prompt: 'Newer saved format' },
        },
      })
    ).status()
  ).toBe(200)
  await expect(page.getByRole('button', { name: 'Load saved format' })).toBeVisible({
    timeout: 20000,
  })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(format).toHaveValue('My unsaved format')
  const after = founderHubSettingsSchema.parse(
    await (await page.request.get(getE2EUrl('/api/founder-hub/settings'))).json()
  )
  expect(
    after.profiles.find((profile) => profile.deviceId === 'auto-test')?.values.auto_summary_prompt
  ).toBe('Newer saved format')
  await page.getByRole('button', { name: 'Load saved format' }).click()
  await expect(format).toHaveValue('Newer saved format')
})

import { randomUUID } from 'node:crypto'
import {
  founderHubSettingsSchema,
  founderHubTemplatePageSchema,
} from 'screenshot-studio-backend-sdk'
import { db, expect, getE2EUrl, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const report = {
  platform: 'linux',
  version: 'test',
  identifier: 'settings-test',
  locale: 'en',
  timezone: 'UTC',
  appStore: false,
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

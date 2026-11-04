import {
  createWorkspace,
  apiRequest,
  chooseOption,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  openWorkspaceSetting,
  test,
} from './framework'
import { socialSetSchema } from '../../lib/api/contracts/social-sets'

async function slotCount(setId: string): Promise<number> {
  const row = await db.row<{ count: number }>(
    `SELECT jsonb_array_length("postingSlots")::int AS count FROM social_set WHERE id = $1`,
    [setId]
  )
  return row?.count ?? -1
}

test('personal settings are addressable, saved on the server and survive a reload', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await openWorkspaceSetting(page, 'Appearance')
  await page.getByRole('radio', { name: /^Light/ }).check()
  await expect(page.locator('html')).toHaveClass(/\blight\b/)
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
  await app.reload()
  await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/\blight\b/)
  await page.getByRole('radio', { name: /^Sunday/ }).check()
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()

  // A save the server refuses never reads as saved: the choice goes back.
  await page.route('**/api/v1/me/preferences', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ body: '{"error":"Refused for the test."}', status: 500 })
      : route.continue()
  )
  // click, not check: the refusal can put the choice back before check() reads it.
  await page.getByRole('radio', { name: /^Dark/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' }).first()).toBeVisible()
  await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked()
  await expect(page.locator('html')).toHaveClass(/\blight\b/)
  await page.unroute('**/api/v1/me/preferences')

  // Each section is its own address, so back and forward move between them.
  await openWorkspaceSetting(page, 'Notifications')
  await page.goBack()
  await expect(page).toHaveURL(/\/settings\/appearance$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/settings\/notifications$/)

  const email = page.getByRole('switch', { name: 'Email notifications' })
  await expect(email).toBeChecked()
  await email.click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
  await app.reload()
  await expect(page.getByRole('switch', { name: 'Email notifications' })).not.toBeChecked()
  await expect(
    page.getByText('No personal Slack account connected.', { exact: true })
  ).toBeVisible()
  await expect(page.getByText('Slack is unavailable.', { exact: false }).first()).toBeVisible()

  await openWorkspaceSetting(page, 'Account')
  await page.getByLabel('Search display time zone').fill('Tokyo')
  await chooseOption(
    page.getByRole('combobox', { exact: true, name: 'Display time zone' }),
    /^Tokyo · Asia\/Tokyo · /
  )
  await page.getByRole('button', { name: 'Save time zone', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
  await app.reload()
  await expect(
    page.getByRole('combobox', { exact: true, name: 'Display time zone' })
  ).toContainText('Asia/Tokyo')

  // The registry says what each experiment is, and promoted or unavailable
  // ones cannot be switched.
  await openWorkspaceSetting(page, 'Experimental')
  await expect(page.getByText('Draft tags')).toBeVisible()
  const tags = page.getByRole('switch', { name: /^Draft tags/ })
  await tags.click()
  await expect(tags).toBeChecked()
  await app.reload()
  await expect(page.getByRole('switch', { name: /^Draft tags/ })).toBeChecked()
})

test('a webhook secret shows once, and private addresses are refused', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await openWorkspaceSetting(page, 'Developer API')
  await page.getByRole('button', { name: 'Add webhook' }).click()
  await page.getByPlaceholder('Zapier').fill('Refused')
  await page.getByPlaceholder('https://example.com/hooks/shots').fill('https://localhost/hook')
  await page.getByRole('checkbox', { name: /draft\.created/ }).check()
  await page.getByRole('button', { name: 'Add webhook' }).click()
  await expect(page.getByText(/private|internal|not allowed|refused/i).first()).toBeVisible()

  await page.getByPlaceholder('Zapier').fill('Receiver')
  await page
    .getByPlaceholder('https://example.com/hooks/shots')
    .fill('https://example.com/shots-e2e')
  await page.getByRole('button', { name: 'Add webhook' }).click()
  const notice = page.getByText('Copy this signing secret now. It is not shown again.')
  await expect(notice).toBeVisible()
  const secret = (await page.locator('code', { hasText: /^whsec_/ }).textContent()) ?? ''
  expect(secret).toMatch(/^whsec_/)

  await app.reload()
  await expect(page.getByText('Receiver')).toBeVisible()
  await expect(notice).toHaveCount(0)
  await expect(page.getByText(secret)).toHaveCount(0)
})

test(
  'publishing brands keep their own names, schedules and settings beside the composer',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })

    await app.open('/settings/publishing-brands')
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Publishing brands' })
    ).toBeVisible()

    // Two sets may share a name; each is its own by ID.
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      const created = await apiRequest(page, '/api/v1/social-sets', {
        method: 'POST',
        body: { name: 'Brand', visibility: 'PRIVATE' },
      })
      expect(created.status).toBe(201)
      ids.push(socialSetSchema.parse(created.body).id)
    }
    expect(ids[0]).not.toEqual(ids[1])
    const setId = ids[1] ?? ''

    // A new set posts weekdays at 9:00. A second weekday time makes two rows
    // of five: ten weekly slots, as the server saved them.
    await app.open(`/settings/publishing-brands/${setId}/scheduling`)
    await expect(page.getByTestId('weekly-slot-count')).toHaveText('5 weekly posting slots')
    await page.getByLabel('Search scheduling time zone').fill('Paris')
    await chooseOption(
      page.getByRole('combobox', { exact: true, name: 'Scheduling time zone' }),
      /^Paris · Europe\/Paris · /
    )
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await chooseOption(page.getByLabel('Time to add'), /^1:00\sPM$/)
    await page.getByRole('button', { name: 'Add time' }).click()
    await expect(page.getByTestId('weekly-slot-count')).toHaveText('10 weekly posting slots')
    await expect.poll(() => slotCount(setId)).toBe(10)
    await app.reload()
    await expect(page.getByTestId('weekly-slot-count')).toHaveText('10 weekly posting slots')
    await expect(
      page.getByRole('combobox', { exact: true, name: 'Scheduling time zone' })
    ).toContainText('Europe/Paris')

    await app.open('/settings/brand-kit')
    await page
      .getByLabel('Product description', { exact: true })
      .fill('Social publishing for teams')
    await page.getByLabel('Audience', { exact: true }).fill('Product teams')
    await page.getByLabel('Tone', { exact: true }).fill('Direct and concrete')
    await page.getByRole('button', { name: 'Save brand voice', exact: true }).click()
    await expect(page.getByText('Brand voice saved.', { exact: true })).toBeVisible()
    await app.open(`/settings/publishing-brands/${setId}/writing-assistant`)
    await expect(page.getByText(/Workspace default: Direct and concrete/)).toBeVisible()
    await page.getByLabel('Tone', { exact: true }).fill('Playful')
    await page.getByRole('button', { name: 'Save style guide', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await app.reload()
    const tone = page.getByLabel('Tone', { exact: true })
    await expect(tone).toHaveValue('Playful')
    await tone.locator('..').getByRole('button', { name: 'Reset to workspace default' }).click()
    await page.getByRole('button', { name: 'Save style guide', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await app.reload()
    await expect(tone).toHaveValue('')
    await expect(page.getByText(/Workspace default: Direct and concrete/)).toBeVisible()

    // Settings open beside a draft without losing what was typed, and the
    // editor runs text in the direction Appearance chose.
    await app.open('/settings/appearance')
    await page.getByRole('radio', { name: /^Right to left/ }).check()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await openNewDraft(page)
    await expect(draftEditor(page)).toHaveAttribute('dir', 'rtl')
    await draftEditor(page).click()
    await page.keyboard.type('Unsaved thought stays put')
    await page.getByRole('button', { name: /^Settings for / }).click()
    await expect(page).toHaveURL(/[?&]settings=scheduling/)
    await expect(page.getByRole('dialog')).toContainText('weekly posting slots')
    await page.goBack()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(draftEditor(page)).toContainText('Unsaved thought stays put')
    await expectSaved(page)
  }
)

test('a public profile is served only while it is turned on', async ({
  app,
  browser,
  identity,
  page,
  startWorkspace,
}) => {
  await startWorkspace({ channels: ['x', 'linkedin'] })

  await app.open('/settings/publishing-brands')
  await page
    .getByRole('link', { name: /^Settings for / })
    .first()
    .click()
  await page.waitForURL(/\/settings\/publishing-brands\/[a-z0-9]+/)
  const setId = new URL(page.url()).pathname.split('/')[3] ?? ''
  await app.open(`/settings/publishing-brands/${setId}/public-profile`)
  const toggle = page.getByRole('switch', { name: 'Make profile public' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  const address = (await page.locator('code', { hasText: '/p/' }).textContent()) ?? ''
  expect(address).toMatch(/\/p\/[0-9a-f]{24}$/)
  const path = new URL(address).pathname

  const visitor = await browser.newContext()
  try {
    const anonymous = await visitor.newPage()
    const shown = await anonymous.goto(path)
    expect(shown?.status()).toBe(200)
    // The default set is named after the workspace; only public identity shows.
    await expect(
      anonymous.getByRole('heading', { level: 1, name: identity.workspaceName })
    ).toBeVisible()
    // Handles come from the social API the first time the set is listed.
    await expect(anonymous.getByText('@shots_x')).toBeVisible()

    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    const hidden = await anonymous.goto(path)
    expect(hidden?.status()).toBe(404)
  } finally {
    await visitor.close()
  }
})

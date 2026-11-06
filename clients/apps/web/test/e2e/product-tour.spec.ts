import { browserRequest, draftEditor, expect, openNewDraft, test, type Page } from './framework'
import { userPreferencesSchema } from '../../lib/api/contracts/settings-platform'

// The first-visit tour is the subject here, so it may start by itself.
test.use({ productTour: true, workspaceOptions: { plan: 'pro' } })

async function dismissedTips(page: Page): Promise<string[]> {
  const response = await browserRequest(page, '/api/v1/me/preferences')
  expect(response.status).toBe(200)
  return userPreferencesSchema.parse(response.body).dismissedTips
}

test('a new member gets the workspace tour once, and the tours menu replays it', async ({
  app,
  context,
  page,
}) => {
  await app.open('/home')
  const card = page.getByTestId('product-tour-step')
  await expect(card.getByRole('heading', { name: 'Start anything from New' })).toBeVisible()
  // The step outlines the element it explains, and focus is on Next.
  await expect(page.locator('[data-tour-id="new"][data-product-tour-active]')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Next' })).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await expect(card.getByRole('heading', { name: 'Home' })).toBeVisible()
  await expect(page.locator('[data-tour-id="nav-home"][data-product-tour-active]')).toBeVisible()
  await card.getByRole('button', { name: 'Back' }).click()
  await expect(card.getByRole('heading', { name: 'Start anything from New' })).toBeVisible()

  // Skipping saves the tour as seen for the account, not only for this tab.
  await card.getByRole('button', { name: 'Skip the tour' }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => dismissedTips(page)).toContain('tour-workspace-v1')

  // A new tab, which has none of this tab's storage, does not start it again.
  const other = await context.newPage()
  await other.goto('/home')
  await expect(other.getByRole('button', { name: 'Product tours' })).toBeVisible()
  // A tour that does not start has no state to wait for: give the 800 ms
  // auto-start delay time to pass, then check that no card opened.
  // eslint-disable-next-line no-restricted-syntax -- proves an absence after the auto-start delay
  await other.waitForTimeout(1_500)
  await expect(other.getByTestId('product-tour-step')).toHaveCount(0)
  await other.close()

  // The menu lists it as seen and replays it from the first step.
  await page.getByRole('button', { name: 'Product tours' }).click()
  await expect(page.getByText('1 of 3 seen')).toBeVisible()
  await page.getByRole('button', { name: 'Replay Find your way around' }).click()
  await expect(card.getByRole('heading', { name: 'Start anything from New' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  // Focus returns to the menu button that started it.
  await expect(page.getByRole('button', { name: 'Product tours' })).toBeFocused()
})

test('the tour does not start over an open menu, so Escape still closes the menu', async ({
  app,
  page,
}) => {
  // Preferences decide when the tour may start; holding them lets the menu open first.
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/me/preferences', async (route) => {
    await held
    await route.continue()
  })
  await app.open('/home')
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: 'New', exact: true })
    .click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  const preferences = page.waitForResponse('**/api/v1/me/preferences')
  release()
  await preferences
  // eslint-disable-next-line no-restricted-syntax -- Proves something does not happen: past the tour's 800 ms start delay.
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('product-tour-step')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
})

test('the tour does not start while the person is typing, so it takes none of their words', async ({
  page,
}) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/v1/me/preferences', async (route) => {
    await held
    await route.continue()
  })
  await openNewDraft(page)
  const editor = draftEditor(page)
  await editor.click()
  await page.keyboard.type('Typing as the page settles')
  const preferences = page.waitForResponse('**/api/v1/me/preferences')
  release()
  await preferences
  // eslint-disable-next-line no-restricted-syntax -- Proves something does not happen: past the tour's own delay.
  await page.waitForTimeout(1_500)
  await expect(page.getByTestId('product-tour-step')).toHaveCount(0)
  await page.keyboard.type(' and carrying on')
  await expect(editor).toContainText('Typing as the page settles and carrying on')
})

test('the workspace tour leads into the Publish tour on its page', async ({ app, page }) => {
  await app.open('/home')
  const card = page.getByTestId('product-tour-step')
  await expect(card.getByRole('heading', { name: 'Start anything from New' })).toBeVisible()
  for (let step = 1; step < 8; step += 1) await page.keyboard.press('ArrowRight')
  await expect(card.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(card.getByText('Next tour: Publish your first post')).toBeVisible()
  await card.getByRole('button', { name: 'Start' }).click()

  await app.expectPath('/publish')
  await expect(card.getByRole('heading', { name: 'Choose a profile' })).toBeVisible()
  await expect(page.locator('[data-tour-id="write-brand"][data-product-tour-active]')).toBeVisible()
  await expect.poll(() => dismissedTips(page)).toContain('tour-workspace-v1')

  // Leaving the step's page ends the tour without marking it seen.
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Home', exact: true })
    .click()
  await app.expectPath('/home')
  await expect(card).toHaveCount(0)
  expect(await dismissedTips(page)).not.toContain('tour-publish-v1')
})

test('the Automate tour goes from a repository to a run, opening each page', async ({
  app,
  page,
}) => {
  await app.open('/workflows/overview')
  const card = page.getByTestId('product-tour-step')
  await card.getByRole('button', { name: 'Skip the tour' }).click()
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: 'Product tours' }).click()
  await page.getByRole('button', { name: /Automate your launches/ }).click()

  await app.expectPath('/workflows/sources')
  await expect(card.getByRole('heading', { name: 'Watch a repository' })).toBeVisible()
  await expect(
    page.locator('[data-tour-id="automate-repositories"][data-product-tour-active]')
  ).toBeVisible()

  await card.getByRole('button', { name: 'Next' }).click()
  await app.expectPath('/workflows/new')
  await expect(card.getByRole('heading', { name: 'Pick a template' })).toBeVisible()
  await expect(
    page.locator('[data-tour-id="automate-templates"][data-product-tour-active]')
  ).toBeVisible()

  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card.getByRole('heading', { name: 'Activate it' })).toBeVisible()
  await expect(
    page.locator('[data-tour-id="nav-automate"][data-product-tour-active]')
  ).toBeVisible()

  await card.getByRole('button', { name: 'Next' }).click()
  await app.expectPath('/workflows/runs')
  await expect(card.getByRole('heading', { name: 'See each run' })).toBeVisible()
  await expect(
    page.locator('[data-tour-id="automate-runs"][data-product-tour-active]')
  ).toBeVisible()

  await card.getByRole('button', { name: 'Finish' }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => dismissedTips(page)).toContain('tour-automate-v1')
})

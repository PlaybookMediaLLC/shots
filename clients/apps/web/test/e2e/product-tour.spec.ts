import { browserRequest, expect, test, type Page } from './framework'
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
  await expect(page.getByText('1 of 2 seen')).toBeVisible()
  await page.getByRole('button', { name: 'Replay Find your way around' }).click()
  await expect(card.getByRole('heading', { name: 'Start anything from New' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  // Focus returns to the menu button that started it.
  await expect(page.getByRole('button', { name: 'Product tours' })).toBeFocused()
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

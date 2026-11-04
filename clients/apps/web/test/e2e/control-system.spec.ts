import { borderContrastOf, expect, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

/** The pages the controls audit scanned, as their routes. */
const AUDITED = [
  '/write/analyze',
  '/write/analyze/observations',
  '/write/settings',
  '/write/plan',
  '/write/batches',
  '/workspace',
  '/workspace/account',
  '/workspace/appearance',
  '/workspace/brand-kit',
  '/workspace/notifications',
  '/workspace/integrations',
  '/workspace/roles',
  '/workspace/channels',
  '/workspace/developers',
  '/workspace/audit-log',
]

/** Browser-drawn controls that ignore the app's fonts, colors and dark mode. */
const NATIVE =
  'select, input[type="time"], input[type="color"], input[type="file"], datalist, details'

test(
  'audited pages draw every control with Shots components',
  { tag: '@journey' },
  async ({ app, page }) => {
    for (const width of [1440, 584]) {
      await page.setViewportSize({ width, height: 900 })
      for (const path of AUDITED) {
        await app.open(path)
        // Hidden inputs behind a button, and Radix's own form mirror, are not drawn.
        const drawn = await page.locator(NATIVE).evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const box = node.getBoundingClientRect()
              return (
                box.width > 1 &&
                box.height > 1 &&
                getComputedStyle(node).visibility !== 'hidden' &&
                !node.closest('[aria-hidden="true"]')
              )
            })
            .map((node) => node.outerHTML.slice(0, 120))
        )
        expect(drawn, `${path} at ${width}px`).toEqual([])
        for (const box of await page
          .locator('[data-slot="checkbox"][data-state="unchecked"]:visible')
          .all())
          expect(await borderContrastOf(box), `${path} unchecked checkbox`).toBeGreaterThanOrEqual(
            3
          )
      }
    }
  }
)

test('one time-zone picker finds a city, and times read the way they are typed', async ({
  app,
  page,
}) => {
  await app.open('/workspace')
  const zone = page.getByRole('combobox', { exact: true, name: 'Timezone' })
  await zone.click()
  await page.keyboard.type('Paris')
  const paris = page.getByRole('option').first()
  await expect(paris).toContainText('Paris · UTC')
  await expect(paris).toContainText('Europe/Paris')
  await page.keyboard.press('Escape')
  // The main label never shows a raw IANA name.
  await expect(zone).not.toContainText('/')

  const time = page.getByLabel('Default publishing time', { exact: true })
  await time.fill('930p')
  await time.blur()
  await expect(time).toHaveValue('9:30 PM')
  await page.getByRole('button', { name: 'Choose a time', exact: true }).click()
  const chosen = page.getByRole('option', { name: '9:30 PM', exact: true })
  await expect(chosen).toHaveAttribute('data-selected', 'true')
  await expect(chosen).toBeInViewport()
})

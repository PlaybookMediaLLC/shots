import { apiRequest, expect, test, trpcMutation } from './framework'
import { socialSetSchema } from '../../lib/api/contracts/social-sets'

test.use({ workspaceOptions: { plan: 'pro' } })

/** Each section with pages, as the sidebar lists them; the first is where the section opens. */
const SECTIONS = [
  ['Create', ['New', 'Recent', 'Templates', 'Tools']],
  ['Campaigns', ['All campaigns', 'Release inbox', 'Deliveries', 'Archived']],
  ['Publish', ['Posts', 'Calendar', 'Bulk tools', 'Analyze', 'Link checks']],
  [
    'Library',
    ['Screenshots', 'Canvas', 'Story Sets', 'Store screenshots', 'Assets', 'Brand assets'],
  ],
  ['Automate', ['Workflows', 'Runs', 'Deployments', 'Sources']],
] as const

test(
  'every sidebar item keeps its section highlighted, with one current page',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/home')
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    const destinations = sidebar.getByRole('navigation', { name: 'Workspace' })
    const currentPage = sidebar.locator('[aria-current="page"]')
    const markedSections = sidebar.locator('[data-platform-nav][aria-current]')
    for (const name of ['Home', 'Activity']) {
      await destinations.getByRole('link', { name, exact: true }).click()
      await expect(destinations.getByRole('link', { name, exact: true })).toHaveAttribute(
        'aria-current',
        'page'
      )
      await expect(currentPage).toHaveCount(1)
    }
    for (const [section, pages] of SECTIONS) {
      const row = destinations.getByRole('link', { name: section, exact: true })
      await row.click()
      const subpages = sidebar.getByRole('navigation', { name: section, exact: true })
      // A section opens its first page, which has a name of its own.
      await expect(subpages.getByRole('link', { name: pages[0], exact: true })).toHaveAttribute(
        'aria-current',
        'page'
      )
      for (const name of pages) {
        await subpages.getByRole('link', { name, exact: true }).click()
        await expect(subpages.getByRole('link', { name, exact: true })).toHaveAttribute(
          'aria-current',
          'page'
        )
        // The section stays marked: the sidebar never jumps to another one.
        await expect(row).toHaveAttribute('aria-current', 'true')
        await expect(markedSections).toHaveCount(1)
        await expect(currentPage).toHaveCount(1)
      }
    }
  }
)

test('Library shows brand kits in place, and leaving Settings returns there', async ({
  app,
  page,
}) => {
  const kit = await trpcMutation(page, 'brandKit.create', {
    name: 'Wayfinding kit',
    publish: true,
    definition: {
      schemaVersion: 1,
      colors: { text: '#111111', background: '#ffffff', accent: '#ff3300' },
      typography: { headingFamily: 'inter' },
    },
  })
  expect(kit.status, JSON.stringify(kit.body)).toBe(200)

  await app.open('/library?view=brand')
  const card = page.getByRole('listitem').filter({
    has: page.getByRole('heading', { name: 'Wayfinding kit', exact: true }),
  })
  await expect(card.getByRole('list', { name: 'Colours' })).toContainText('#ff3300')
  await expect(page).toHaveTitle(/^Brand assets · Library \| Shots$/)

  await page.getByRole('link', { name: 'Edit in Settings' }).click()
  await expect(page).toHaveURL(/\/settings\/brand-kit$/)
  await page.getByRole('link', { name: 'Back, leave settings', exact: true }).click()
  await expect(page).toHaveURL(/\/library\?view=brand$/)
  await expect(
    page
      .getByRole('navigation', { name: 'Library', exact: true })
      .first()
      .getByRole('link', { name: 'Brand assets', exact: true })
  ).toHaveAttribute('aria-current', 'page')
})

test('a brand’s settings open over the Calendar, on the same pages as Settings', async ({
  app,
  page,
}) => {
  const created = await apiRequest(page, '/api/v1/social-sets', {
    method: 'POST',
    body: { name: 'Wayfinding brand', visibility: 'PRIVATE' },
  })
  expect(created.status).toBe(201)
  const brand = socialSetSchema.parse(created.body)

  await app.open('/publish/calendar')
  await page
    .getByRole('complementary', { name: 'Calendar accounts' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`[?&]settings=scheduling&brand=${brand.id}`))
  const sheet = page.getByRole('dialog', { name: 'Wayfinding brand settings' })
  await expect(sheet).toContainText('weekly posting slots')
  const tabs = sheet.getByRole('navigation', { name: 'Settings pages' }).getByRole('button')
  await expect(tabs).toHaveText(['Scheduling', 'New draft', 'Public profile', 'Writing Assistant'])
  await expect(sheet.getByRole('link', { name: 'Open in Settings' })).toHaveAttribute(
    'href',
    `/settings/publishing-brands/${brand.id}/scheduling`
  )
  // Closing returns to the Calendar it opened over.
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(page).toHaveURL(/\/publish\/calendar/)
  await expect(page).not.toHaveURL(/[?&](settings|brand)=/)
})

test('old addresses open their new pages', async ({ page }) => {
  for (const [old, now] of [
    ['/write', '/publish'],
    ['/write/plan', '/publish/calendar'],
    ['/write/deliveries', '/campaigns/deliveries'],
    ['/write/settings', '/settings/publishing-brands'],
    ['/drafts', '/publish'],
    ['/link-preview', '/publish/link-checks'],
    ['/workspace', '/settings'],
    ['/workspace/billing', '/settings/billing'],
    ['/workspace/social-sets', '/settings/publishing-brands'],
    ['/settings/profile', '/settings/account'],
    ['/library?view=templates', '/create?view=templates'],
    ['/projects', '/library'],
    ['/assets', '/library?view=assets'],
    ['/fr/write', '/fr/publish'],
  ] as const) {
    const response = await page.goto(old)
    expect(response?.ok(), old).toBe(true)
    const url = new URL(page.url())
    expect(`${url.pathname}${url.search}`, old).toBe(now)
  }
})

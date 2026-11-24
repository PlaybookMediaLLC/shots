import { apiRequest, expect, test, trpcMutation } from './framework'
import { socialSetSchema } from '../../lib/api/contracts/social-sets'
import { z } from 'zod'

test.use({ workspaceOptions: { plan: 'pro' } })

test('the release Home preview preserves standalone creation and resumes its saved release', async ({
  app,
  page,
}) => {
  await app.open('/home')
  await expect(page.getByRole('region', { name: 'Start something new' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Prepare a release', exact: true })).toHaveCount(0)
  await app.open('/home?view=release')
  const starters = page.getByRole('region', {
    name: 'Start with a release, or create something on its own',
  })
  await expect(starters.getByRole('link', { name: /Create a visual/ })).toBeVisible()
  await expect(starters.getByRole('button', { name: /Write a post/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Find an existing release' })).toHaveAttribute(
    'href',
    '/campaigns/releases'
  )
  await page.getByRole('link', { name: 'Prepare a release', exact: true }).click()
  await page.getByLabel('Release title').fill('Preview release')
  await page.getByLabel('Why it matters').fill('Return to the same reviewed work.')
  await page.getByRole('button', { name: 'Create campaign', exact: true }).click()
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/campaigns\/c[a-z0-9]+$/)
  const campaignPath = new URL(page.url()).pathname
  await app.open('/home?view=release')
  const recent = page.getByRole('region', { name: 'Continue working' })
  await recent.getByRole('button', { name: 'Campaigns', exact: true }).click()
  await expect(recent.getByRole('link', { name: /Preview release/ })).toHaveAttribute(
    'href',
    campaignPath
  )
  await recent.getByRole('link', { name: /Preview release/ }).click()
  await app.expectPath(campaignPath)
  await expect(page.getByRole('link', { name: 'Source release' })).toBeVisible()
  await app.open('/home?view=release')
  await page.getByRole('link', { name: 'Show all starters' }).click()
  await app.expectPath('/home')
  await expect(page.getByRole('region', { name: 'Start something new' })).toBeVisible()
})

test('Home and command search find releases and campaigns beyond the recent window', async ({
  app,
  page,
}) => {
  const visual = z.object({ id: z.string() }).parse(
    (
      await trpcMutation(page, 'project.create', {
        name: 'Older visual',
        document: { version: 2, image: { src: null } },
      })
    ).body
  )
  const release = z.object({ release: z.object({ id: z.string() }) }).parse(
    (
      await trpcMutation(page, 'release.create', {
        title: 'Needle release',
        benefitStatement: 'Find the original context.',
      })
    ).body
  ).release
  const campaign = z.object({ campaign: z.object({ id: z.string() }) }).parse(
    (
      await trpcMutation(page, 'campaign.create', {
        name: 'Needle campaign',
        objective: 'Explain this release',
        releaseId: release.id,
      })
    ).body
  ).campaign
  for (let index = 0; index < 6; index++) {
    expect(
      (
        await trpcMutation(page, 'release.create', {
          title: `Later release ${index}`,
          benefitStatement: 'Later work',
        })
      ).status
    ).toBe(200)
    expect(
      (
        await trpcMutation(page, 'campaign.create', {
          name: `Later campaign ${index}`,
          objective: 'Later work',
        })
      ).status
    ).toBe(200)
  }
  const reads = new Map<string, number>()
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/trpc/')) return
    for (const name of path.slice('/api/trpc/'.length).split(',')) {
      if (name === 'release.list' || name === 'campaign.list')
        reads.set(name, (reads.get(name) ?? 0) + 1)
    }
  })
  await app.open('/home')
  const recent = page.getByRole('region', { name: 'Continue working' })
  await expect(
    page
      .getByRole('region', { name: 'Recents', exact: true })
      .getByRole('link', { name: 'Older visual', exact: true })
  ).toHaveAttribute('href', `/editor?project=${visual.id}`)
  await expect(recent.getByRole('link', { name: /Later campaign/ }).first()).toBeVisible()
  await expect(recent.getByRole('link', { name: /Needle/ })).toHaveCount(0)
  await recent.getByRole('button', { name: 'Releases', exact: true }).click()
  await expect(recent.getByRole('link', { name: 'View all releases' })).toHaveAttribute(
    'href',
    '/campaigns/releases'
  )
  for (const width of [320, 390, 640, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    const posts = recent.getByRole('button', { name: 'Posts', exact: true })
    await posts.focus()
    await expect(posts).toBeInViewport()
    await page.keyboard.press('Enter')
    await expect(posts).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({
      path: test.info().outputPath(`home-work-${width}.png`),
      fullPage: true,
    })
  }
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog')
  await expect(search).toBeVisible()
  expect(Object.fromEntries(reads)).toEqual({ 'release.list': 1, 'campaign.list': 1 })
  await search.getByRole('searchbox', { name: 'Search destinations' }).fill('Needle')
  await expect(
    search.getByRole('link', { name: 'Needle release Release', exact: true })
  ).toHaveAttribute('href', `/releases/${release.id}`)
  await expect(
    search.getByRole('link', { name: 'Needle campaign Campaign', exact: true })
  ).toHaveAttribute('href', `/campaigns/${campaign.id}`)
  await search.getByRole('link', { name: 'Needle campaign Campaign', exact: true }).click()
  await app.expectPath(`/campaigns/${campaign.id}`)
  await expect(page.getByRole('link', { name: 'Source release', exact: true })).toBeVisible()
})

test('Home sends each recent-work kind to its owning collection', async ({ app, page }) => {
  const created = await apiRequest(page, '/api/v1/content-drafts', {
    method: 'POST',
    body: { title: 'Find this post again' },
  })
  expect(created.status).toBe(201)
  await app.open('/home')
  const recent = page.getByRole('region', { name: 'Continue working' })
  await expect(recent.getByRole('link', { name: /Find this post again/ })).toBeVisible()
  await recent.getByRole('button', { name: 'Posts', exact: true }).click()
  await expect(recent.getByRole('link', { name: 'View all posts' })).toHaveAttribute(
    'href',
    '/publish'
  )
  await expect(recent.getByRole('link', { name: 'View all screenshots' })).toHaveCount(0)
  await recent.getByRole('link', { name: 'View all posts' }).click()
  await app.expectPath('/publish')
  await expect(page.getByText('Find this post again', { exact: true }).first()).toBeVisible()
  await app.open('/home')
  await recent.getByRole('button', { name: 'Screenshots', exact: true }).click()
  await expect(recent.getByRole('link', { name: 'View all screenshots' })).toHaveAttribute(
    'href',
    '/library'
  )
  await expect(recent.getByText(/Open the full collection below/)).toBeVisible()
  await app.open('/create')
  await expect(
    page.getByRole('link', {
      name: 'Store screenshots App Store studio · Browser and workspace projects',
      exact: true,
    })
  ).toBeVisible()
})

/** Each section with pages, as the sidebar lists them; the first is where the section opens. */
const SECTIONS = [
  ['Create', ['New', 'Recent', 'Templates', 'Tools']],
  ['Campaigns', ['All campaigns', 'Release inbox', 'Deliveries', 'Archived']],
  ['Publish', ['Posts', 'Calendar', 'Bulk tools', 'Analyze', 'Link checks']],
  [
    'Library',
    ['Screenshots', 'Canvas', 'Story Sets', 'Store screenshots', 'Assets', 'Brand assets'],
  ],
  ['Automate', ['Overview', 'Workflows', 'Repositories', 'Runs', 'Deployments']],
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

test('Activity and Settings stay on screen on a short window, whichever section is open', async ({
  app,
  page,
}) => {
  await page.setViewportSize({ width: 1156, height: 600 })
  for (const path of ['/workflows/overview', '/library']) {
    await app.open(path)
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    for (const name of ['Activity', 'Settings']) {
      const link = sidebar.getByRole('link', { name, exact: true })
      await expect(link).toBeInViewport({ ratio: 1 })
      // On top where it is drawn: nothing covers or clips it.
      expect(
        await link.evaluate((element) => {
          const { bottom, left, right, top } = element.getBoundingClientRect()
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          const edge = document.elementFromPoint((left + right) / 2, bottom - 1)
          return element.contains(hit) && element.contains(edge)
        })
      ).toBe(true)
    }
  }
})

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
  // The sheet holds what writing needs; the rest of the brand is one link away.
  await expect(sheet.getByRole('navigation', { name: 'Settings pages' })).toHaveCount(0)
  await expect(sheet.getByRole('link', { name: /^All settings for / })).toHaveAttribute(
    'href',
    new RegExp(`/settings/publishing-brands/${brand.id}(/general)?$`)
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

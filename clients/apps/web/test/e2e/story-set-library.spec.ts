import { mkdir, readFile } from 'node:fs/promises'
import {
  chooseOption,
  db,
  expect,
  getActiveOrganizationId,
  type Route,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'
import { createCreativeSet } from '@/lib/creative-sets/recipes'
import { DESIGN_DOCUMENT_VERSION } from '@/lib/design/document'

test.use({ workspaceOptions: { plan: 'pro' } })

test.beforeEach(async ({ workspace }) => {
  await db.query(
    `UPDATE workspace_entitlement SET "featureOverrides" = $2::jsonb WHERE "organizationId" = $1`,
    [workspace.id, JSON.stringify({ 'creative-sets:create': false })]
  )
})

const listRoute = '**/api/trpc/**creativeSet.list**'

test(
  'restricted members can request access, preview formats and keep working in Projects',
  { tag: '@journey' },
  async ({ app, page }) => {
    for (const name of ['Launch', 'Product update']) {
      expect(
        (
          await trpcMutation(page, 'project.create', {
            name,
            document: { version: DESIGN_DOCUMENT_VERSION, image: { src: null } },
          })
        ).status
      ).toBe(200)
    }
    await app.open('/creative-sets')
    await expect(page).toHaveTitle(/Story Sets/)
    await expect(page.getByRole('link', { name: 'Request design-partner access' })).toHaveAttribute(
      'href',
      '/contact'
    )
    await expect(page.getByRole('link', { name: 'View Projects' })).toHaveAttribute(
      'href',
      '/library'
    )
    await expect(page.getByText(/You have 2 saved projects/)).toBeVisible()
    await expect(page.getByLabel('Example Story Set')).toBeVisible()
    await expect(page.getByRole('button', { name: 'New Story Set' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'No Story Sets yet' })).toBeVisible()
    await mkdir('.context', { recursive: true })
    await page.addStyleTag({ content: 'nextjs-portal { display: none; }' })
    await page.screenshot({ path: '.context/story-sets-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 375, height: 812 })
    await expect(page.getByRole('link', { name: 'Request design-partner access' })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    await page.screenshot({ path: '.context/story-sets-mobile.png', fullPage: true })

    const story = createCreativeSet({
      headline: 'Plan your week',
      supporting: '',
      treatment: 'product-hero',
      source: {
        id: 'source',
        src: 'asset:11111111-1111-4111-8111-111111111111',
        name: 'test.png',
        revision: 1,
        width: 1440,
        height: 900,
      },
      focus: { x: 0, y: 0, width: 1, height: 1 },
    })
    // A schema-valid payload reaches the real entitlement check before asset storage.
    const id = `c${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
    const denied = await trpcMutation(page, 'creativeSet.create', {
      id,
      name: 'Denied',
      document: story,
    })
    expect(denied.status).toBe(403)
    expect(await trpcQuery(page, 'creativeSet.get', { creativeSetId: id })).toMatchObject({
      status: 404,
    })
    expect((await trpcQuery(page, 'creativeSet.list', {})).body).toMatchObject({ items: [] })
  }
)

test(
  'unknown and malformed links stop loading and provide a way back',
  { tag: '@journey' },
  async ({ app, page }) => {
    for (const id of [
      'clxxxxxxxxxxxxxxxxxxxxxxx',
      'does-not-exist-123',
      '11111111-1111-4111-8111-111111111111',
    ]) {
      const missing = await trpcQuery(page, 'creativeSet.get', { creativeSetId: id })
      expect(missing).toMatchObject({ status: 404, body: { message: 'Story Set not found.' } })
      await app.open(`/creative-sets/${id}`)
      await expect(page.getByRole('heading', { name: 'Story Set not found' })).toBeVisible()
      await expect(page.getByText('Opening Story Set…')).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Back to Story Sets' })).toHaveAttribute(
        'href',
        '/creative-sets'
      )
    }
    await page.getByRole('link', { name: 'Back to Story Sets' }).click()
    await expect(page.getByRole('heading', { name: 'Story Sets', exact: true })).toBeVisible()
  }
)

test(
  'failed list requests hide the empty state and can be retried',
  { tag: '@journey' },
  async ({ app, page }) => {
    let searchFailures = 0
    const fail = (route: Route) => {
      if (route.request().url().includes('launch')) searchFailures += 1
      return route.abort('internetdisconnected')
    }
    await page.route(listRoute, fail)
    await app.open('/creative-sets')
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'We couldn’t load your Story Sets.'
    )
    await expect(page.getByRole('heading', { name: 'No Story Sets yet' })).toHaveCount(0)
    await page.getByRole('searchbox', { name: 'Search Story Sets' }).fill('launch')
    // The transport retries a failed read twice. Unblocking before the search's
    // last attempt lets that retry succeed on its own, and Retry never shows.
    await expect.poll(() => searchFailures).toBeGreaterThanOrEqual(3)
    await expect(page.getByRole('main').getByRole('alert')).toContainText(
      'We couldn’t load your Story Sets.'
    )
    await expect(page.getByRole('heading', { name: 'No matching Story Sets' })).toHaveCount(0)
    await page.unroute(listRoute, fail)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByText('No Story Sets match “launch”.')).toBeVisible()
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(page.getByRole('heading', { name: 'No Story Sets yet' })).toBeVisible()
  }
)

test(
  'search and sorting survive navigation and long or blank queries are safe',
  { tag: '@journey' },
  async ({ app, page }) => {
    // An empty library hides search until there is a query to refine.
    await app.open('/creative-sets?search=launch')
    const search = page.getByRole('searchbox', { name: 'Search Story Sets' })
    await expect(page.getByText('No Story Sets match “launch”.')).toBeVisible()
    let listRequests = 0
    page.on('request', (request) => {
      if (request.url().includes('creativeSet.list')) listRequests++
    })
    // Surrounding whitespace does not change the query, so nothing is fetched again.
    await search.fill('  launch  ')
    // eslint-disable-next-line no-restricted-syntax -- Proves the search debounce sends nothing; an absence needs a window.
    await page.waitForTimeout(400)
    expect(listRequests).toBe(0)
    await chooseOption(page.getByRole('combobox', { name: 'Sort Story Sets' }), 'Name')
    await expect(page).toHaveURL(/sort=name/)
    await page.getByRole('link', { name: 'View Projects' }).click()
    await expect(page).toHaveTitle(/Screenshots · Library/)
    await page.goBack()
    await expect(search).toHaveValue('launch')
    await expect(page.getByRole('combobox', { name: 'Sort Story Sets' })).toContainText('Name')
    await search.fill('x'.repeat(201))
    await expect(search).toHaveValue('x'.repeat(200))
    await expect(page.getByRole('heading', { name: 'No matching Story Sets' })).toBeVisible()
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
    await app.open(`/creative-sets?search=${'y'.repeat(201)}`)
    await expect(search).toHaveValue('y'.repeat(200))
    await expect(page.getByRole('heading', { name: 'No matching Story Sets' })).toBeVisible()
    await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
  }
)

test(
  'a detail network failure offers Retry without an endless loading message',
  { tag: '@journey' },
  async ({ app, page }) => {
    const fail = (route: Route) => route.abort('internetdisconnected')
    const route = '**/api/trpc/**creativeSet.get**'
    await page.route(route, fail)
    await app.open('/creative-sets/clxxxxxxxxxxxxxxxxxxxxxxx')
    await expect(page.getByRole('heading', { name: 'Could not open this Story Set' })).toBeVisible()
    await expect(page.getByText('Opening Story Set…')).toHaveCount(0)
    await page.unroute(route, fail)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Story Set not found' })).toBeVisible()
  }
)

test(
  'saved sets preview their own formats, missing formats and pending evidence review',
  { tag: '@journey' },
  async ({ app, page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const organizationId = await getActiveOrganizationId(page)
    const bytes = await readFile('public/demo/notion-showcase.webp')
    const upload = await trpcMutation(page, 'asset.signUpload', {
      bytes: bytes.length,
      classification: 'input',
      contentType: 'image/webp',
      fileName: 'story-preview-evidence.webp',
    })
    expect(upload.status).toBe(200)
    const { asset, uploadUrl } = upload.body as { asset: { id: string }; uploadUrl: string }
    expect(
      (
        await page.request.put(uploadUrl, {
          data: bytes,
          headers: { 'content-type': 'image/webp', 'if-none-match': '*' },
        })
      ).ok()
    ).toBe(true)
    expect((await trpcMutation(page, 'asset.completeUpload', { assetId: asset.id })).status).toBe(
      200
    )

    const fixtures = [
      { name: 'Launch planning', headline: 'Plan your next launch', background: '#e3eee7' },
      { name: 'Shared workspace', headline: 'One place for every project', background: '#dfeafa' },
      { name: 'Team updates', headline: 'Keep the team in sync', background: '#f4e6d5' },
    ].map((fixture, index) => {
      const document = createCreativeSet({
        headline: fixture.headline,
        supporting: '',
        treatment: 'product-hero',
        source: {
          id: 'proof',
          src: `asset:${asset.id}`,
          name: 'proof.webp',
          revision: 1,
          width: 1600,
          height: 987,
        },
        focus: { x: 0, y: 0, width: 1, height: 1 },
      })
      document.brand = { id: 'fixture-brand', name: 'Saved brand', version: 1 }
      for (const output of document.outputs) output.document.background!.value = fixture.background
      if (index === 1)
        document.outputs = document.outputs.filter((output) => output.format !== 'square')
      if (index === 2) {
        document.stories[0]!.headline = 'Stay in sync, wherever you work'
        for (const output of document.outputs) {
          output.overrides.headline = true
          output.review.wording = true
          output.review.source = true
        }
      }
      return {
        ...fixture,
        document,
        id: `c${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`,
      }
    })
    // Seed only the test runner's local database; creation remains gated for this member.
    for (const [index, fixture] of fixtures.entries()) {
      await db.query(
        `INSERT INTO platform_creative_set (id, "organizationId", name, document, "documentVersion", revision, "updatedAt")
         VALUES ($1, $2, $3, $4::jsonb, 2, 1, $5)`,
        [
          fixture.id,
          organizationId,
          fixture.name,
          JSON.stringify(fixture.document),
          new Date(Date.now() - index * 86400000),
        ]
      )
    }

    await page.setViewportSize({ width: 1440, height: 1100 })
    await app.open('/creative-sets')
    const cards = page.getByRole('main').locator('article')
    await expect(cards).toHaveCount(3)
    for (const [index, fixture] of fixtures.entries()) {
      const card = cards.nth(index)
      await card.scrollIntoViewIfNeeded()
      await expect(card.getByRole('link', { name: fixture.name, exact: true })).toHaveAttribute(
        'href',
        `/creative-sets/${fixture.id}`
      )
      await expect(card.locator('[data-story-format] img')).toHaveCount(index === 1 ? 2 : 3, {
        timeout: 120_000,
      })
      await expect(card).toContainText('Last edited')
      await expect(card.getByText('Needs review', { exact: true })).toHaveCount(index === 2 ? 1 : 0)
      await expect(card.getByRole('img')).toHaveCount(0)
      const boxes = await card.locator('[data-story-format]').evaluateAll((tiles) =>
        tiles.map((tile) => {
          const { width, height, bottom } = tile.getBoundingClientRect()
          return { width, height, bottom }
        })
      )
      expect(boxes[0]!.width / boxes[1]!.width).toBeCloseTo(1600 / 1080, 1)
      expect(boxes[2]!.width / boxes[1]!.width).toBeCloseTo(1, 1)
      expect(Math.abs(boxes[0]!.bottom - boxes[2]!.bottom)).toBeLessThan(1)
      expect(boxes[2]!.width / boxes[2]!.height).toBeCloseTo(1080 / 1350, 1)
      // The renderer receives the saved brand, not the example's default palette.
      const background = await card
        .locator('[data-story-format="wide"] img')
        .evaluate(async (image) => {
          await (image as HTMLImageElement).decode()
          const canvas = document.createElement('canvas')
          canvas.width = 480
          canvas.height = 270
          const context = canvas.getContext('2d')!
          context.drawImage(image as HTMLImageElement, 0, 0)
          return Array.from(context.getImageData(5, 5, 1, 1).data).slice(0, 3)
        })
      const expected = fixture.background.match(/[a-f0-9]{2}/g)!.map((hex) => parseInt(hex, 16))
      background.forEach((channel, i) => expect(Math.abs(channel - expected[i]!)).toBeLessThan(8))
    }
    await expect(cards.nth(1).locator('[data-story-format="square"]')).toHaveText('Square')
    const desktopBoxes = await cards.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().top)
    )
    expect(desktopBoxes[0]).toBe(desktopBoxes[1])
    expect(desktopBoxes[2]).toBeGreaterThan(desktopBoxes[1]!)
    await page.addStyleTag({ content: 'nextjs-portal { display: none; }' })
    await mkdir('.context', { recursive: true })
    await page.getByRole('heading', { name: 'Story Sets', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.context/story-set-previews-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 375, height: 812 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true)
    const mobileBoxes = await cards.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().top)
    )
    expect(mobileBoxes[1]).toBeGreaterThan(mobileBoxes[0]!)
    await page.getByRole('heading', { name: 'Story Sets', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.context/story-set-previews-mobile.png', fullPage: true })

    await page.getByRole('searchbox', { name: 'Search Story Sets' }).fill('Shared')
    await expect(cards).toHaveCount(1)
    await expect(cards.first()).toContainText('Shared workspace')
    await page.getByRole('searchbox', { name: 'Search Story Sets' }).fill('')
    await chooseOption(page.getByRole('combobox', { name: 'Sort Story Sets' }), 'Name')
    await expect(cards).toHaveCount(3)
    await expect(cards.first()).toContainText('Launch planning')
    await page.getByRole('link', { name: 'Launch planning', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/creative-sets/${fixtures[0]!.id}$`))
    expect(errors).toEqual([])

    // An unavailable source must leave a named neutral tile, never an invented preview.
    let failedDownloads = 0
    await page.route('**/api/trpc/**asset.signDownload**', (route) => {
      failedDownloads++
      return route.abort('failed')
    })
    await app.open('/creative-sets')
    await app.reload()
    await cards.first().scrollIntoViewIfNeeded()
    await expect.poll(() => failedDownloads).toBeGreaterThan(0)
    for (const format of ['wide', 'square', 'portrait']) {
      await expect(cards.first().locator(`[data-story-format="${format}"]`)).toHaveText(
        format[0]!.toUpperCase() + format.slice(1)
      )
    }
    await expect(cards.first().locator('[data-story-format] img')).toHaveCount(0)
  }
)

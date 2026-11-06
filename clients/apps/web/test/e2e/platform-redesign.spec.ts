import { createHash, randomBytes } from 'node:crypto'
import {
  browserRequest,
  db,
  expect,
  expectSaved,
  getActiveOrganizationId,
  openNewDraft,
  requestJson,
  test,
  trpcMutation,
  trpcQuery,
  uploadSignedAsset,
  editorMore,
} from './framework'
import { mkdir } from 'node:fs/promises'

test.use({ workspaceOptions: { plan: 'pro' } })

test.beforeAll(async () => {
  await mkdir('.context/ux-redesign', { recursive: true })
})

test(
  'job navigation preserves projects and one command owner restores focus',
  { tag: '@journey' },
  async ({ app, page }) => {
    const created = await trpcMutation(page, 'project.create', {
      name: 'Navigation proof',
      document: { version: 2, image: { src: null } },
    })
    expect(created.status).toBe(200)
    const id = (created.body as { id: string }).id
    await app.open('/home')
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    await expect(sidebar).toHaveAttribute('data-navigation', 'expanded')
    for (const name of [
      'Home',
      'Create',
      'Campaigns',
      'Publish',
      'Library',
      'Automate',
      'Activity',
      'Settings',
    ])
      await expect(sidebar.getByRole('link', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('link', { name: /Navigation proof/ })).toHaveAttribute(
      'href',
      `/?project=${id}`
    )
    const search = sidebar.getByRole('button', { name: 'Search and commands' })
    await search.focus()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.getByRole('searchbox', { name: 'Search destinations' }).fill('library')
    await expect(
      page
        .getByRole('navigation', { name: 'Search results' })
        .getByRole('link', { name: /Library/ })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(search).toBeFocused()
    await sidebar.getByRole('link', { name: 'Library', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
    await expect(page.getByText('Screenshot projects · Saved to workspace')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open Navigation proof' })).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: '.context/ux-redesign/library-desktop.png', fullPage: true })
    await app.open(`/editor?project=${id}&editor=screenshot`)
    await expect(page).toHaveURL(new RegExp(`[?]project=${id}&editor=screenshot$`))
    expect((await trpcQuery(page, 'project.get', { projectId: id })).status).toBe(200)
    await app.open(`/fr/home?project=${id}&editor=screenshot`)
    await expect(page).toHaveURL(new RegExp(`/fr[?]project=${id}&editor=screenshot$`))
  }
)

test(
  'mobile settings puts content first and local work remains explicitly local',
  { tag: '@journey' },
  async ({ app, page }) => {
    for (const width of [320, 390, 767, 768, 769, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await app.open('/settings/appearance')
      await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible()
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)
      // Settings sections live in the navigation: the drawer on phones, the sidebar beside it.
      if (width < 768) {
        const opener = page.getByRole('button', { name: 'Open navigation', exact: true })
        await opener.click()
        const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
        await expect(drawer).toBeVisible()
        await drawer.getByRole('searchbox', { name: 'Search settings' }).fill('security')
        await expect(drawer.getByRole('link', { name: 'Security', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(opener).toBeFocused()
        // Choosing a section closes the drawer on the new page.
        await opener.click()
        await drawer.getByRole('link', { name: 'Security', exact: true }).click()
        await expect(page).toHaveURL(/\/settings\/security$/)
        await expect(drawer).toBeHidden()
      } else {
        await expect(
          page
            .getByRole('navigation', { name: 'Settings sections', exact: true })
            .getByRole('link', { name: 'Security', exact: true })
        ).toBeVisible()
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: '.context/ux-redesign/settings-mobile.png', fullPage: true })
    await app.open('/library?type=store')
    await expect(page.getByRole('heading', { name: 'On this browser', exact: true })).toBeVisible()
    await expect(
      page.getByText('These projects belong to this browser profile.', { exact: false })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Navigation', exact: true })
      .getByRole('link', { name: 'Create', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Create', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: '.context/ux-redesign/create-mobile.png', fullPage: true })
  }
)

test(
  'workflow and release views are separate, and an explicit compact preference survives',
  { tag: '@journey' },
  async ({ app, page }) => {
    // The old address of Repositories still works.
    await app.open('/workflows?view=sources')
    await expect(page).toHaveURL(/\/workflows\/sources$/)
    await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Workflow summary' })).toHaveCount(0)
    await page
      .getByRole('navigation', { name: 'Automate', exact: true })
      .getByRole('link', { name: 'Workflows', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Workflows', exact: true })).toBeVisible()
    await app.open('/campaigns/releases')
    await expect(page.getByRole('heading', { name: 'Release inbox', exact: true })).toBeVisible()
    await app.open('/settings/appearance')
    await page.getByRole('radio', { name: /^Always compact/ }).check()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await app.reload()
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute(
      'data-navigation',
      'compact'
    )
    // The compact rail lists every settings section as an icon, without the search box.
    const sections = page.getByRole('navigation', { name: 'Settings sections', exact: true })
    await expect(sections.getByRole('link')).toHaveCount(23)
    await expect(sections.getByRole('searchbox')).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand navigation' }).click()
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute(
      'data-navigation',
      'expanded'
    )
  }
)

test(
  'Library attaches an existing asset and refuses one deleted after selection',
  { tag: '@journey' },
  async ({ app, page }) => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    )
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const upload = async (fileName: string) => {
      const signed = await requestJson(page, '/api/tenant/assets/upload-url', {
        bytes: bytes.length,
        classification: 'input',
        contentType: 'image/png',
        fileName,
        sha256,
      })
      expect(signed.status).toBe(201)
      const { asset, uploadUrl } = signed.body as { asset: { id: string }; uploadUrl: string }
      expect(await uploadSignedAsset(page, uploadUrl, [...bytes], 'image/png')).toBe(200)
      expect(
        (await requestJson(page, `/api/tenant/assets/${asset.id}/complete`, { sha256 })).status
      ).toBe(200)
      return asset.id
    }
    const kept = await upload('kept-library.png')
    const removed = await upload('removed-library.png')
    const draftId = await openNewDraft(page)
    await editorMore(page, 'From Library')
    const picker = page.getByRole('dialog', { name: 'Attach from Library' })
    await picker.getByRole('button', { name: 'removed-library.png', exact: true }).click()
    expect((await trpcMutation(page, 'asset.delete', { assetId: removed })).status).toBe(200)
    await picker.getByRole('button', { name: 'Attach 1', exact: true }).click()
    await expect(picker.getByRole('alert')).toBeVisible()
    await expect(picker).toBeVisible()
    // What was refused is unticked, so only the kept asset is attached.
    await picker.getByRole('button', { name: 'kept-library.png', exact: true }).click()
    await picker.getByRole('button', { name: 'Attach 1', exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expectSaved(page)
    const saved = await browserRequest(page, `/api/v1/content-drafts/${draftId}`)
    expect(saved.status).toBe(200)
    expect(JSON.stringify(saved.body)).toContain(kept)
    expect(JSON.stringify(saved.body)).not.toContain(removed)
    expect((await trpcQuery(page, 'asset.signDownload', { assetId: kept })).status).toBe(200)
    await app.reload()
    await expect(
      page.getByRole('textbox', { name: 'Draft body' }).locator(`img[src*="${kept}"]`)
    ).toBeVisible()

    // From the Library, the same asset starts a new post without being uploaded again.
    await app.open('/library?view=assets')
    await page.getByRole('button', { name: 'Use kept-library.png in a post', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
    await page.waitForURL(
      (url) => /^\/publish\/[a-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith(draftId)
    )
    const postId = new URL(page.url()).pathname.split('/').pop()!
    await expect(
      page.getByRole('textbox', { name: 'Draft body' }).locator(`img[src*="${kept}"]`)
    ).toBeVisible({ timeout: 60_000 })
    const post = await browserRequest(page, `/api/v1/content-drafts/${postId}`)
    expect(JSON.stringify(post.body)).toContain(kept)
  }
)

test(
  'saved work shows on Home right away and search finds it by name, with failures named',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/home')
    const recent = page.getByRole('region', { name: 'Continue working' })
    await expect(recent.getByText('Your work will appear here')).toBeVisible()
    const created = await trpcMutation(page, 'project.create', {
      name: 'Harbor launch hero',
      document: { version: 2, image: { src: null } },
    })
    const id = (created.body as { id: string }).id
    // Leaving and coming back within the list's cache time still shows the new work.
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    await sidebar.getByRole('link', { name: 'Library', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
    await sidebar.getByRole('link', { name: 'Home', exact: true }).click()
    await expect(recent.getByRole('link', { name: /Harbor launch hero/ })).toBeVisible()

    // An empty search offers recent work; words find work by name, not only places.
    await page.keyboard.press('Control+k')
    const results = page.getByRole('navigation', { name: 'Search results' })
    await expect(results.getByRole('link', { name: 'Harbor launch hero Screenshot' })).toBeVisible()
    const box = page.getByRole('searchbox', { name: 'Search destinations' })
    await box.fill('harbor')
    await expect(
      results.getByRole('link', { name: 'Harbor launch hero Screenshot' })
    ).toHaveAttribute('href', `/?project=${id}`)
    await box.fill('qzxj nothing')
    await expect(results.getByRole('status')).toContainText(
      'Search finds places in Shots and posts, screenshots, and canvases by name or words.'
    )
    // A collection that cannot be searched says so instead of looking empty.
    await page.route('**/api/v1/content-drafts?*', (route) =>
      route.fulfill({ status: 500, body: '{}' })
    )
    await box.fill('harbor launch')
    await expect(results).toContainText('Some work could not be searched right now.')
    await expect(results.getByRole('link', { name: 'Harbor launch hero Screenshot' })).toBeVisible()
  }
)

// @dev-server until fixed: on the production build the aborted image route does not fail the library preview.
test(
  'a failed preview retries without rewriting the saved project',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page }) => {
    const document = { version: 2, image: { src: '/demo/notion-showcase.webp' } }
    const created = await trpcMutation(page, 'project.create', { name: 'Retry proof', document })
    const id = (created.body as { id: string }).id
    const before = await trpcQuery(page, 'project.get', { projectId: id })
    let requests = 0
    await page.route('**/demo/notion-showcase.webp', async (route) => {
      requests++
      await route.abort()
    })
    await app.open('/library')
    await expect(
      page.getByText('Preview could not render. Open the original to keep working.')
    ).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('link', { name: 'Open Retry proof' })).toHaveAttribute(
      'href',
      `/?project=${id}`
    )
    const failedRequests = requests
    await page.getByRole('button', { name: 'Retry preview' }).click()
    await expect.poll(() => requests).toBeGreaterThan(failedRequests)
    await page.unroute('**/demo/notion-showcase.webp')
    await page.getByRole('button', { name: 'Retry preview' }).click()
    await expect(page.getByRole('img', { name: 'Preview of Retry proof' })).toBeVisible({
      timeout: 60_000,
    })
    expect((await trpcQuery(page, 'project.get', { projectId: id })).body).toEqual(before.body)
  }
)

test(
  'localized destinations and light-theme reflow retain keyboard access',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/settings/appearance')
    await page.getByRole('radio', { name: /^Light/ }).check()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    await app.open('/fr/home')
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    await expect(sidebar.getByRole('link', { name: 'Bibliothèque', exact: true })).toHaveAttribute(
      'href',
      '/fr/library'
    )
    await sidebar.getByRole('link', { name: 'Bibliothèque', exact: true }).click()
    await expect(page).toHaveURL(/\/fr\/library$/)
    await expect(page.locator('html')).toHaveClass(/\blight\b/)
    // 640 and 320 CSS px model the reflow available at 200% and 400% on a 1280px viewport.
    for (const width of [640, 320]) {
      await page.setViewportSize({ width, height: 900 })
      for (const direction of ['ltr', 'rtl']) {
        await page.evaluate((dir) => {
          document.documentElement.dir = dir
        }, direction)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true
        )
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: '.context/ux-redesign/library-light-rtl.png', fullPage: true })
  }
)

test(
  'workflow graph stays in the shell and preserves validation, test, and dirty navigation',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    const installationId = `c${randomBytes(12).toString('hex')}`
    const sourceId = `c${randomBytes(12).toString('hex')}`
    const organizationId = await getActiveOrganizationId(page)
    try {
      // Local protocol fixture: no GitHub account or worker is contacted.
      await db.query(
        `INSERT INTO github_installation (id, "installationId", "accountLogin", "accountType", "updatedAt") VALUES ($1, $2, 'fixture', 'Organization', now())`,
        [installationId, Date.now()]
      )
      await db.query(
        `INSERT INTO workspace_github_installation (id, "organizationId", "githubInstallationId", "connectedByUserId") SELECT $1, $2, $3, id FROM "user" WHERE email=$4`,
        [`c${randomBytes(12).toString('hex')}`, organizationId, installationId, identity.email]
      )
      await db.query(
        `INSERT INTO source_app (id, "organizationId", name, provider, "externalId", "allowedHosts", "githubInstallationId", status, "updatedAt") VALUES ($1, $2, 'fixture/product', 'github', '123', '[]', $3, 'ACTIVE', now())`,
        [sourceId, organizationId, installationId]
      )
      await app.open('/workflows/new')
      await page.getByRole('button', { name: 'Start with a blank workflow' }).click()
      await page.getByRole('button', { name: 'Open blank draft' }).click()
      const editor = page.getByRole('main', { name: 'Workflow editor', exact: true })
      await expect(editor).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible()
      await page.getByLabel('Workflow name', { exact: true }).fill('Shell workflow proof')
      await page.getByRole('button', { name: 'Save draft', exact: true }).click()
      await expect(page).toHaveURL(/\/workflows\/c[a-z0-9]+$/)
      await page.getByRole('tab', { name: 'Workflow', exact: true }).click()
      await page.getByLabel('Priority', { exact: true }).fill('99999')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Canvas', exact: true }).click()
      await page.getByRole('button', { name: 'Save draft', exact: true }).click()
      await expect(page.getByLabel('Priority', { exact: true })).toBeFocused()
      await expect(page.getByRole('region', { name: 'Workflow canvas' })).toBeHidden()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      await page.getByLabel('Priority', { exact: true }).fill('77')
      await page.getByRole('button', { name: 'Close editor', exact: true }).click()
      const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })
      await expect(discard).toBeVisible()
      await discard.getByRole('button', { name: 'Keep editing' }).click()
      await page.getByRole('button', { name: 'Save draft', exact: true }).click()
      await expect(page.getByText('Draft saved and validated by the backend.')).toBeVisible()
      await page.getByRole('button', { name: 'Test draft', exact: true }).click()
      await expect(page.getByText('Preview: completed', { exact: true })).toBeVisible()
      const overview = await trpcQuery(page, 'releaseAutomation.overview', undefined)
      const definitions = (
        overview.body as {
          definitions: {
            name: string
            priority: number
            enabled: boolean
            activeVersionId: string | null
          }[]
        }
      ).definitions
      expect(definitions.find((item) => item.name === 'Shell workflow proof')).toMatchObject({
        priority: 77,
        enabled: false,
        activeVersionId: null,
      })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.screenshot({ path: '.context/ux-redesign/workflow-desktop.png', fullPage: true })
    } finally {
      await db.query('DELETE FROM workspace_github_installation WHERE "githubInstallationId"=$1', [
        installationId,
      ])
      await db.query('DELETE FROM github_installation WHERE id=$1', [installationId])
    }
  }
)

test(
  'all template families have previews and hidden scrollbars retain scrolling',
  { tag: '@journey' },
  async ({ app, page }) => {
    const before = await trpcQuery(page, 'releaseAutomation.overview')
    await app.open('/create?view=templates')
    const catalog = page.getByRole('region', { name: 'Template previews' })
    await expect(catalog).toBeVisible()
    const previews = catalog.getByRole('img', { name: /^Preview of / })
    await expect(previews.first()).toBeVisible()
    await expect(catalog.locator('img').first()).toBeVisible()
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth)
    ).toBe('none')
    expect(
      await page.evaluate(() => getComputedStyle(document.body, '::-webkit-scrollbar').display)
    ).toBe('none')
    await page.mouse.move(1000, 650)
    await page.mouse.wheel(0, 800)
    await expect
      .poll(() => page.locator('[data-platform-scroll]').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await page.locator('[data-platform-scroll]').evaluate((el) => el.scrollTo(0, 0))
    await page.locator('[data-platform-scroll]').focus()
    await page.keyboard.press('PageDown')
    await expect
      .poll(() => page.locator('[data-platform-scroll]').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    for (const category of [
      'Animated',
      'Layouts & presets',
      'Canvas',
      'Store screenshots',
      'Workflows',
    ]) {
      await catalog.getByRole('button', { name: category, exact: true }).click()
      await expect(previews.first()).toBeVisible()
      expect(await previews.count()).toBeGreaterThan(0)
      if (category === 'Layouts & presets') {
        for (const preview of await previews.all()) {
          await preview.scrollIntoViewIfNeeded()
          await expect(preview.locator('img')).toBeVisible({ timeout: 60000 })
        }
      }
      if (category === 'Canvas')
        await expect(catalog.locator('[data-recipe-preview] img').first()).toBeVisible({
          timeout: 60000,
        })
      if (category === 'Store screenshots') {
        await expect(catalog.locator('[data-store-slide-render]').first()).toBeVisible({
          timeout: 60000,
        })
        await page.screenshot({
          path: '.context/ux-redesign/store-template-previews.png',
          fullPage: false,
          style: 'nextjs-portal {display:none}',
        })
      }
      if (category === 'Workflows') {
        await expect(previews).toHaveCount(5)
        await expect(
          catalog.getByText('Skips pre-releases and patch versions.', { exact: true })
        ).toBeVisible()
        await page.screenshot({
          path: '.context/ux-redesign/template-catalog.png',
          fullPage: true,
          style: 'nextjs-portal {display:none}',
        })
      }
    }
    expect((await trpcQuery(page, 'releaseAutomation.overview')).body).toEqual(before.body)
    await app.open('/workflows/new')
    // The cards do not wait for the workspace: each says what sets it apart, in words.
    await expect(page.getByRole('link', { name: /Use this template/ })).toHaveCount(0)
    await expect(page.getByText('Only production deployments.')).toBeVisible()
    // Each shows what comes out: a sample draft, its channel, and who decides.
    await expect(page.getByText(/^Example draft for /)).toHaveCount(5)
    await expect(page.getByText('Waits for a person to approve it')).toHaveCount(5)
    await expect(page.getByText('Weekly recurring campaign')).toHaveCount(0)
    await page
      .getByRole('link', { name: 'Product launch from a GitHub release', exact: true })
      .click()
    // The choice is in the address, so a detour keeps it, and only what is missing is asked for.
    await expect(page).toHaveURL(/template=release-launch/)
    await expect(
      page.getByRole('heading', { name: 'Product launch from a GitHub release', level: 1 })
    ).toBeVisible()
    expect((await trpcQuery(page, 'releaseAutomation.overview')).body).toEqual(before.body)
    await page.screenshot({
      path: '.context/ux-redesign/workflow-template-previews.png',
      fullPage: true,
      style: 'nextjs-portal {display:none}',
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await app.open('/create?view=templates')
    await expect(page.getByRole('region', { name: 'Template previews' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await app.open('/settings/appearance')
    await expect(page.getByRole('switch', { name: 'Show scrollbars' })).toHaveCount(0)
  }
)

test(
  'sidebar choices persist across client navigation and content scrolls inside the shell',
  { tag: '@journey' },
  async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    let releaseSession!: () => void
    const sessionReady = new Promise<void>((resolve) => {
      releaseSession = resolve
    })
    await page.route('**/api/auth/get-session', async (route) => {
      await sessionReady
      await route.continue()
    })
    try {
      await app.open('/home')
      await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeDisabled()
    } finally {
      releaseSession()
    }
    await expect(page.getByRole('button', { name: 'Collapse navigation' })).toBeEnabled()
    await page.getByRole('button', { name: 'Collapse navigation' }).click()
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toHaveAttribute(
      'data-navigation',
      'compact'
    )
    await page.unroute('**/api/auth/get-session')
    await app.open('/settings/appearance')
    await page.getByRole('radio', { name: /^Always compact/ }).check()
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
    await page.getByRole('button', { name: 'Expand navigation' }).click()
    await expect(sidebar).toHaveAttribute('data-navigation', 'expanded')
    const documents: string[] = []
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        documents.push(request.url())
    })
    // Settings pages list their sections; the back link returns to the destinations.
    await sidebar.getByRole('link', { name: 'Back, leave settings', exact: true }).click()
    await expect(sidebar.getByRole('link', { name: 'Home', exact: true })).toBeVisible()
    await expect(sidebar).toHaveAttribute('data-navigation', 'expanded')
    for (const [name, heading] of [
      ['Home', 'Home'],
      ['Library', 'Library'],
      ['Automate', 'Workflows'],
      ['Create', 'Create'],
    ]) {
      await sidebar.getByRole('link', { name, exact: true }).click()
      await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible()
      await expect(sidebar).toHaveAttribute('data-navigation', 'expanded')
    }
    expect(documents).toEqual([])
    await expect(sidebar).toHaveCSS('border-right-width', '0px')
    // The shell's icons are Phosphor, on a 256-unit viewBox.
    await expect(
      sidebar.getByRole('link', { name: 'Home', exact: true }).locator('svg')
    ).toHaveAttribute('viewBox', '0 0 256 256')
    // The collapse control shares the footer row with the theme switch, above the switcher.
    const toggle = sidebar.getByRole('button', { name: 'Collapse navigation' })
    const theme = sidebar.getByRole('button', { name: /^Switch to (light|dark) mode$/ })
    const account = sidebar.getByRole('button', { name: 'Open account menu' })
    expect(Math.abs((await toggle.boundingBox())!.y - (await theme.boundingBox())!.y)).toBeLessThan(
      4
    )
    expect((await toggle.boundingBox())!.y).toBeLessThan((await account.boundingBox())!.y)
    await toggle.click()
    await expect(sidebar).toHaveAttribute('data-navigation', 'compact')
    await sidebar.getByRole('link', { name: 'Home', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await expect(sidebar).toHaveAttribute('data-navigation', 'compact')
    await page.screenshot({
      path: '.context/ux-redesign/home-compact-polished.png',
      style: 'nextjs-portal {display:none}',
    })
    await app.reload()
    await expect(sidebar).toHaveAttribute('data-navigation', 'compact')
    await sidebar.getByRole('button', { name: 'Expand navigation' }).click()
    await page.screenshot({
      path: '.context/ux-redesign/home-polished.png',
      style: 'nextjs-portal {display:none}',
    })
    await sidebar.getByRole('button', { name: 'Search and commands' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect
      .poll(async () => (await page.getByRole('dialog').boundingBox())!.width)
      .toBeCloseTo(576, 0)
    await page.screenshot({
      path: '.context/ux-redesign/search-polished.png',
      style: 'nextjs-portal {display:none}',
    })
    await page.keyboard.press('Escape')
    await sidebar.getByRole('link', { name: 'Publish', exact: true }).click()
    await expect(page.getByTestId('write-frame')).toBeVisible()
    await page.keyboard.press('Control+k')
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect
      .poll(async () => (await page.getByRole('dialog').boundingBox())!.width)
      .toBeCloseTo(1440 * 0.8, 0)
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 844 })
    await app.open('/home')
    await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible()
    await page.screenshot({
      path: '.context/ux-redesign/home-mobile-polished.png',
      style: 'nextjs-portal {display:none}',
    })
    await page.mouse.move(200, 600)
    await page.mouse.wheel(0, 900)
    await expect
      .poll(() => page.locator('[data-platform-scroll]').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible()
    await page
      .getByRole('dialog', { name: 'Navigation', exact: true })
      .getByRole('link', { name: 'Automate', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: 'Automate', exact: true, level: 1 })
    ).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
)

test(
  'theme switch persists across pages and reloads, with an honest rollback on failure',
  { tag: '@journey' },
  async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await app.open('/home')
    const light = page
      .getByRole('button', { name: 'Switch to light mode' })
      .filter({ visible: true })
    await expect(light).toBeEnabled()
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/me/preferences') && response.request().method() === 'PATCH'
    )
    await light.click()
    expect((await saved).status()).toBe(200)
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.screenshot({ path: '.context/ux-redesign/home-light.png', fullPage: true })
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Library', exact: true })
      .click()
    await expect(page.getByRole('heading', { name: 'Library', exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/light/)
    await app.reload()
    const dark = page.getByRole('button', { name: 'Switch to dark mode' }).filter({ visible: true })
    await expect(dark).toBeEnabled()
    await page.route('**/api/v1/me/preferences', (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporarily unavailable' }),
          })
        : route.continue()
    )
    await dark.click()
    await expect(page.getByText('Temporarily unavailable', { exact: false }).first()).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/light/)
    await page.unroute('**/api/v1/me/preferences')
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileDark = page
      .getByRole('button', { name: 'Switch to dark mode' })
      .filter({ visible: true })
    await expect(mobileDark).toBeEnabled()
    await mobileDark.focus()
    const darkSaved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/me/preferences') && response.request().method() === 'PATCH'
    )
    await page.keyboard.press('Enter')
    expect((await darkSaved).status()).toBe(200)
    await expect(page.locator('html')).toHaveClass(/dark/)
    await app.open('/home')
    await expect(page.getByText('No notifications', { exact: true })).toBeVisible()
    await page.screenshot({ path: '.context/ux-redesign/home-dark-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: '.context/ux-redesign/home-dark.png', fullPage: true })
  }
)

test(
  'Library opens on saved files when no project exists, and several start one post',
  { tag: '@journey' },
  async ({ app, page }) => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    )
    await app.open('/library?view=assets')
    const input = page.getByLabel('Upload files')
    await input.setInputFiles([
      { buffer: bytes, mimeType: 'image/png', name: 'first.png' },
      { buffer: bytes, mimeType: 'image/png', name: 'second.png' },
    ])
    await expect(page.getByText('2 files uploaded')).toBeVisible()
    await app.open('/library')
    await expect(page).toHaveURL(/\/library\?view=assets$/)

    await page.getByRole('checkbox', { name: 'Select first.png', exact: true }).click()
    await page.getByRole('checkbox', { name: 'Select second.png', exact: true }).click()
    await page.getByRole('button', { name: 'Use 2 in post', exact: true }).click()
    await page.waitForURL((url) => /^\/publish\/[a-z0-9]+$/.test(url.pathname))
    await expect(page.getByTestId('media-strip-item')).toHaveCount(2, { timeout: 60_000 })
  }
)

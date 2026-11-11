import { expect, type Page, test } from './framework'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

test.use({ workspaceOptions: { plan: 'pro' } })

async function savedText(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('screenshotstudio-db')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get('screenshotstudio-draft')
        request.onsuccess = () => resolve(request.result?.imageState.textOverlays[0]?.text)
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
}

test('draft saves changes at the end of long text with the same length', async ({ app, page }) => {
  await app.openEditor()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  const original = `${'A long heading '.repeat(24)}before`
  const edited = `${'A long heading '.repeat(24)}after!`
  await page.getByLabel('Text content', { exact: true }).fill(original)
  await expect.poll(() => savedText(page)).toBe(original)
  await page.getByLabel('Text content', { exact: true }).fill(edited)
  await expect.poll(() => savedText(page), { timeout: 5_000 }).toBe(edited)
  await app.reload()
  await expect(page.locator('[data-text-overlay-id]')).toContainText(edited)
})

test('leaving the editor flushes a pending draft', async ({ app, page }) => {
  await app.openEditor()
  await page.request.get('/projects')
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  await page.getByLabel('Text content', { exact: true }).fill('Saved first')
  await expect.poll(() => savedText(page)).toBe('Saved first')
  await page.getByLabel('Text content', { exact: true }).fill('Saved before leaving')
  await page.getByRole('link', { name: 'Library', exact: true }).click()
  await expect.poll(() => savedText(page), { timeout: 5_000 }).toBe('Saved before leaving')
  await app.open('/')
  await expect(page.locator('[data-text-overlay-id]')).toContainText('Saved before leaving')
})

test('App Store save failure keeps the open project and does not report success', async ({
  app,
  page,
}) => {
  await app.open('/create/store')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'projects')
        throw new DOMException('Test storage full', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await page.getByTitle('Rename project', { exact: true }).click()
  await page.getByLabel('Project name', { exact: true }).fill('Unsaved audit project')
  await page.getByLabel('Project name', { exact: true }).press('Enter')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible()
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /^Saved$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Projects in this browser…' }).click()
  await page.getByRole('button', { name: 'New blank project' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Projects in this browser', exact: true })
  ).toBeVisible()
  await expect(page.getByTitle('Rename project')).toHaveText('Unsaved audit project')
})

test('App Store canvas and editing controls remain usable on a phone', async ({ app, page }) => {
  await app.open('/create/store')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  const banner = page.getByRole('button', { name: 'Dismiss banner' })
  if (await banner.isVisible()) await banner.click()
  await expect
    .poll(async () => (await page.locator('[data-store-canvas]').boundingBox())?.width ?? 0)
    .toBeGreaterThan(250)
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  const tools = page.getByRole('dialog', { name: 'Tools', exact: true })
  await expect(tools.getByRole('tab', { name: 'Layers', exact: true })).toBeVisible()
  await tools.getByRole('option', { name: /^Heading/ }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Inspector', exact: true }).click()
  await page.getByLabel('Heading text', { exact: true }).fill('Edited on a phone')
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-store-canvas-slide]')).toContainText('Edited on a phone')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(
    page.getByRole('status').filter({ hasText: /^Saved on this browser$/ })
  ).toBeVisible()
  await page.screenshot({ path: '.context/editor-audit/mobile-after.png', animations: 'disabled' })
})

/**
 * The New menu opens Store screenshots at /create/store; Back returns to
 * the screenshot editor. Both share one layout, so each stays mounted with its own session.
 */
async function switchEditor(page: Page, section: 'Screenshot editor' | 'App Store Screenshots') {
  if (section === 'App Store Screenshots') {
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: 'New', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Store screenshots', exact: true }).click()
    await expect(page).toHaveURL(/\/create\/store(\/|$)/)
  } else {
    await page.goBack()
    await expect(page).not.toHaveURL(/\/create\/store/)
  }
}

test(
  'editor sections preserve projects, selection, uploaded assets and independent history',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
    await page.getByLabel('Text content', { exact: true }).fill('Main editor audit')
    await page.getByRole('button', { name: 'Save as project', exact: true }).click()
    await page.getByLabel('Project name').fill('Main audit project')
    await page.getByRole('button', { name: 'Save project', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Project Main audit project: Saved' })
    ).toBeVisible()
    const projectId = new URL(page.url()).searchParams.get('project')

    await switchEditor(page, 'App Store Screenshots')
    await page.getByRole('button', { name: 'Use the sample set' }).click()
    const canvas = page.locator('[data-store-canvas-slide]:visible')
    await expect(canvas).toBeVisible()
    await page.getByRole('option', { name: /^Heading/ }).click()
    await page.getByLabel('Heading text', { exact: true }).fill('Store editor audit')
    await page.getByRole('option', { name: /^Device/ }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    await (await chooser).setFiles(resolve('public/store-screenshot-write.png'))
    const uploaded = canvas.locator('img[src^="blob:"]')
    await expect(uploaded).toHaveCount(1)
    await expect
      .poll(() => uploaded.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await expect(page).toHaveURL(/\/create\/store\/[^/]+$/)
    const storeId = new URL(page.url()).pathname.split('/').pop()

    await switchEditor(page, 'Screenshot editor')
    await expect(page.getByLabel('Text content', { exact: true })).toHaveValue('Main editor audit')
    await page.getByRole('button', { name: /^Undo/ }).click()
    await expect(page.locator('[data-text-overlay-id]:visible')).not.toContainText(
      'Main editor audit'
    )
    await page.getByRole('button', { name: /^Redo/ }).click()
    await expect(page.locator('[data-text-overlay-id]:visible')).toContainText('Main editor audit')

    await switchEditor(page, 'App Store Screenshots')
    await expect(canvas).toContainText('Store editor audit')
    await expect(page.getByRole('option', { name: /^Device/ })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await expect
      .poll(() => uploaded.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: /^Undo/ }).click()
    await expect(uploaded).toHaveCount(0)
    await page.getByRole('button', { name: /^Redo/ }).click()
    await expect(uploaded).toHaveCount(1)
    await expect(
      page.getByRole('status').filter({ hasText: /^Saved on this browser$/ })
    ).toBeVisible()
    await page.screenshot({ path: '.context/editor-audit/integrated-desktop.png' })
    await expect(page).toHaveURL(new RegExp(`/create/store/${storeId}$`))
    await page.screenshot({
      path: '.context/editor-audit/integrated-navigation.png',
      animations: 'disabled',
    })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const storeDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: /^Export \d+ files$/ }).click()
    const zip = await JSZip.loadAsync(await readFile((await (await storeDownload).path())!))
    const iphone = Object.values(zip.files).find((file) => file.name.endsWith('_1320x2868.png'))
    expect(iphone).toBeDefined()
    const pixels = await iphone!.async('nodebuffer')
    expect([pixels.readUInt32BE(16), pixels.readUInt32BE(20), pixels[25]]).toEqual([1320, 2868, 2])
    await app.reload()
    await expect(canvas).toContainText('Store editor audit')
    await expect
      .poll(() => uploaded.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await switchEditor(page, 'Screenshot editor')
    await expect(page.locator('[data-text-overlay-id]:visible')).toContainText('Main editor audit')
    expect(new URL(page.url()).searchParams.get('project')).toBe(projectId)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.getByRole('button', { name: 'PNG', exact: true }).click()
    const mainDownload = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export as PNG', exact: true }).click()
    const mainPng = await readFile((await (await mainDownload).path())!)
    expect(mainPng.subarray(1, 4).toString()).toBe('PNG')
    expect(mainPng.readUInt32BE(16) / mainPng.readUInt32BE(20)).toBeCloseTo(4 / 3, 2)
  }
)

test('mobile editor navigation works with the keyboard and browser back', async ({ app, page }) => {
  await app.openEditor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true })
  await navigation.getByRole('link', { name: 'Create', exact: true }).press('Enter')
  await expect(navigation).toBeHidden()
  await expect(page).toHaveURL(/\/create$/)
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Store screenshots App Store studio/ })
    .press('Enter')
  await expect(page.getByRole('button', { name: 'Use the sample set' })).toBeVisible()
  await expect(page).toHaveTitle('Store screenshots · Create | Shots')
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  // Store screenshots is one of Create's pages: the row marks the section, the page link is current.
  await expect(navigation.getByRole('link', { name: 'Create', exact: true })).toHaveAttribute(
    'aria-current',
    'true'
  )
  await expect(
    navigation.getByRole('link', { name: 'Store screenshots', exact: true })
  ).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
  await page.goBack()
  await expect(page).toHaveURL(/\/create$/)
})

test('adding slides keeps the active image, accepts a repeated file, and rejects invalid input', async ({
  app,
  page,
}) => {
  await app.openEditor()
  const chooser = page.waitForEvent('filechooser')
  await page.getByText('Drag & drop, click to browse, or paste', { exact: true }).click()
  await (await chooser).setFiles(resolve('public/demo/demo-2.png'))
  const main = page.locator('img[alt="Main image"]')
  await expect(main).toBeVisible()
  const add = page.getByLabel('Add slides', { exact: true })
  await add.setInputFiles(resolve('public/store-screenshot-write.png'))
  await page.getByRole('button', { name: 'Select slide 2', exact: true }).click()
  const active = await main.getAttribute('src')
  await add.setInputFiles(resolve('public/store-screenshot-write.png'))
  await expect(page.getByRole('button', { name: 'Select slide 3', exact: true })).toBeVisible()
  await expect(main).toHaveAttribute('src', active!)
  await add.setInputFiles({
    name: 'invalid.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg/>'),
  })
  await expect(
    page.getByText('File type not supported. Use PNG, JPG, or WEBP.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select slide 4', exact: true })).toHaveCount(0)
  await expect(main).toHaveAttribute('src', active!)
})

test('deleting the open App Store project does not save it back into the library', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await switchEditor(page, 'App Store Screenshots')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Projects in this browser…' }).click()
  await page
    .getByRole('dialog', { name: 'Projects in this browser', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete project', exact: true })
    .click()
  await expect(page.getByRole('button', { name: 'Use the sample set' })).toBeVisible()
  await app.reload()
  await expect(page.getByRole('button', { name: 'Use the sample set' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your projects', exact: true })).toHaveCount(0)
})

test('initial App Store imports are consumed once and do not reopen in a new project', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await switchEditor(page, 'App Store Screenshots')
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Import screenshots…', exact: true }).click()
  await (await chooser).setFiles(resolve('public/store-screenshot-write.png'))
  const dialog = page.getByRole('dialog', { name: 'Import screenshots', exact: true })
  await expect(
    dialog.getByRole('list', { name: 'Screenshots to import' }).getByRole('listitem')
  ).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Create 1 slide', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(
    page.getByRole('listbox', { name: 'Slides', exact: true }).getByRole('option')
  ).toHaveCount(1)
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Projects in this browser…' }).click()
  await page.getByRole('button', { name: 'New blank project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Untitled set', exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
})

test('App Store tabs and layers support keyboard selection and reordering', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await switchEditor(page, 'App Store Screenshots')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  const layers = page.getByRole('tab', { name: 'Layers', exact: true })
  await layers.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Insert', exact: true })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Insert', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.keyboard.press('ArrowLeft')
  const rows = page.locator('[data-layer-row]')
  await expect(rows.first()).toHaveAttribute('tabindex', '0')
  await rows.first().focus()
  await page.keyboard.press('Space')
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  const id = await rows.first().getAttribute('data-layer-row')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(rows.nth(1)).toHaveAttribute('data-layer-row', id!)
})

test('App Store transforms, device frames, visibility and backgrounds persist', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await switchEditor(page, 'App Store Screenshots')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  const canvas = page.locator('[data-store-canvas-slide]:visible')
  const heading = canvas.locator('[data-store-text-role="heading"]')
  const before = (await heading.boundingBox())!
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
  await page.mouse.down()
  await page.mouse.move(before.x + before.width / 2 + 25, before.y + before.height / 2 + 20, {
    steps: 8,
  })
  await page.mouse.up()
  await expect.poll(async () => (await heading.boundingBox())!.x - before.x).toBeGreaterThan(10)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect
    .poll(async () => Math.abs((await heading.boundingBox())!.x - before.x))
    .toBeLessThan(1)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()

  await page.getByRole('option', { name: /^Device/ }).click()
  await page.getByRole('combobox', { name: 'Model', exact: true }).click()
  await page.getByRole('option', { name: 'Phones · iPhone 17', exact: true }).click()
  await page.getByLabel('Scale', { exact: true }).fill('80')
  await page.getByLabel('Scale', { exact: true }).press('Enter')
  const rotation = page.getByLabel('Rotation', { exact: true })
  await rotation.fill('15')
  await rotation.press('Enter')
  await rotation.fill('invalid')
  await rotation.press('Tab')
  await expect(rotation).toHaveValue('15')
  await page.getByRole('button', { name: 'Hide Device', exact: true }).click()
  await expect(canvas.locator('[data-store-layer-type="device"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(canvas.locator('[data-store-layer-type="device"]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Background and slide settings', exact: true }).click()
  const background = canvas.locator('[data-store-background]')
  const oldBackground = await background.getAttribute('style')
  await page
    .getByRole('group', { name: 'Background presets', exact: true })
    .getByRole('button')
    .last()
    .click()
  await expect(background).not.toHaveAttribute('style', oldBackground!)
  const savedBackground = await background.getAttribute('style')
  await expect(
    page.getByRole('status').filter({ hasText: /^Saved on this browser$/ })
  ).toBeVisible()
  await app.reload()
  await expect(background).toHaveAttribute('style', savedBackground!)
  await page.getByRole('option', { name: /^Device/ }).click()
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveText(
    'Phones · iPhone 17'
  )
  await expect(page.getByLabel('Scale', { exact: true })).toHaveValue('80')
  await expect(page.getByLabel('Rotation', { exact: true })).toHaveValue('15')
})

test('App Store opens from the editor by keyboard, mobile navigation reaches Create; Settings opens its own menu', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: 'New', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Store screenshots', exact: true }).press('Enter')
  await expect(page).toHaveURL(/\/create\/store$/)
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  // Settings is one link; as in Polar, its sections replace the destinations there.
  const workspace = page.getByRole('navigation', { name: 'Workspace', exact: true })
  const settings = workspace.getByRole('link', { name: 'Settings', exact: true })
  await expect(settings).toHaveAttribute('href', '/settings')
  await expect(page.getByRole('navigation', { name: 'Workspace settings' })).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 1000 })
  await settings.click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(workspace).toHaveCount(0)
  const settingsLinks = page.getByRole('navigation', { name: 'Settings sections', exact: true })
  // Every settings section, including RFC 024's Appearance, Install, Experimental,
  // Social sets, and Founder Hub. Create workspace lives in the account menu.
  await expect(settingsLinks.getByRole('link')).toHaveCount(24)
  await expect(
    settingsLinks.getByRole('link', { name: 'Notifications', exact: true })
  ).toHaveAttribute('href', '/settings/notifications')
  await expect(settingsLinks.getByRole('link', { name: 'General', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  )
  await page.screenshot({
    path: '.context/editor-audit/settings-menu.png',
    animations: 'disabled',
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
  await expect(drawer.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  await drawer.getByRole('link', { name: 'Back, leave settings', exact: true }).press('Enter')
  await expect(drawer).toBeHidden()
  await expect(page).not.toHaveURL(/\/settings/)
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await expect(drawer.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
    'href',
    '/settings'
  )
  await expect(drawer.getByRole('navigation', { name: 'Workspace settings' })).toHaveCount(0)
  await drawer.getByRole('link', { name: 'Create', exact: true }).press('Enter')
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/create$/)
})

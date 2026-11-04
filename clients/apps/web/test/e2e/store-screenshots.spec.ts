import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { createWorkspace, type E2EIdentity, expect, type Page, test } from './framework'

async function openStudio(identity: E2EIdentity, page: Page) {
  await createWorkspace(identity, page)
  await page.goto('/create/store')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  const canvas = page.locator('[data-store-canvas-slide]')
  await expect(canvas).toBeVisible()
  return canvas
}

async function editHeading(page: Page, text: string) {
  const box = (await page.locator('[data-store-canvas-slide]').boundingBox())!
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.1)
  await expect(page.locator('[data-store-inline-editor]')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
}

function pngSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset)
  return { width: view.getUint32(16), height: view.getUint32(20), colorType: bytes[25] }
}

test('edit on the canvas, undo, persist across reloads, and export exact store sizes', async ({
  app,
  identity,
  page,
}) => {
  const canvas = await openStudio(identity, page)
  await editHeading(page, 'Train smarter')
  await expect(canvas).toContainText('Train smarter')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(canvas).not.toContainText('Train smarter')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(canvas).toContainText('Train smarter')

  await expect(page.getByText('Saved on this browser', { exact: true })).toBeVisible()
  await app.reload()
  await expect(page.locator('[data-store-canvas-slide]')).toContainText('Train smarter')

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const exportButton = page.getByRole('button', { name: /^Export \d+ files$/ })
  const count = Number((await exportButton.textContent())!.match(/\d+/)![0])
  const download = page.waitForEvent('download')
  await exportButton.click()
  const zip = await JSZip.loadAsync(await readFile((await (await download).path())!))
  const files = Object.values(zip.files).filter((file) => !file.dir)
  expect(files).toHaveLength(count)
  for (const file of files) {
    const size = pngSize(await file.async('uint8array'))
    const [, width, height] = file.name.match(/_(\d+)x(\d+)\.png$/)!
    expect(size).toEqual({ width: Number(width), height: Number(height), colorType: 2 })
  }
  expect(
    files.some(
      (file) =>
        file.name.startsWith('app-store/en-US/iphone-6.9in/') &&
        file.name.endsWith('_1320x2868.png')
    )
  ).toBe(true)
})

test(
  'share a read-only review link, comment through it, resolve, and revoke',
  { tag: '@journey' },
  async ({ browser, identity, page }) => {
    await openStudio(identity, page)
    await page.getByRole('button', { name: 'Project', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Share for review…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    const linkField = dialog.getByRole('textbox', { name: /^Review link for / }).first()
    await expect(linkField).toBeVisible({ timeout: 60_000 })
    const link = await linkField.inputValue()

    const reviewer = await browser.newContext()
    const reviewPage = await reviewer.newPage()
    await reviewPage.goto(link)
    await expect(reviewPage.getByText('You can comment; you cannot edit')).toBeVisible()
    await expect(reviewPage.locator('[data-store-canvas-slide]')).toHaveCount(0)
    await reviewPage
      .getByRole('button', { name: 'Click to place a comment pin on this slide' })
      .click({ position: { x: 40, y: 60 } })
    await reviewPage.getByLabel('Your name').fill('Riley Reviewer')
    await reviewPage
      .getByRole('textbox', { name: 'Comment', exact: true })
      .fill('Headline is too long on small phones')
    await reviewPage.getByRole('button', { name: 'Comment', exact: true }).click()
    await expect(
      reviewPage.getByRole('article').getByText('Headline is too long on small phones')
    ).toBeVisible()

    await dialog.getByRole('button', { name: 'Close' }).click()
    // Reorder: the commented slide moves to position 2, and its comment must follow it.
    const filmstrip = page.getByRole('listbox', { name: 'Slides' })
    const first = filmstrip.getByRole('option', { name: /^Slide 1 of / })
    const slideName = (await first.getAttribute('aria-label'))!.replace(/^Slide 1 of \d+: /, '')
    await first.focus()
    await page.keyboard.press('Alt+ArrowRight')
    await expect(
      filmstrip.getByRole('option', { name: new RegExp(`^Slide 2 of \\d+: ${slideName}`) })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Project', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Share for review…' }).click()
    await expect(dialog.getByText('Headline is too long on small phones')).toBeVisible()
    await expect(dialog.getByRole('button', { name: `Slide 2 · ${slideName}` })).toBeVisible()
    await dialog.getByRole('checkbox', { name: 'Resolved' }).check()
    await dialog.getByRole('button', { name: 'Revoke…' }).click()
    await dialog.getByRole('button', { name: 'Turn off link' }).click()
    await expect(dialog.getByText(/link turned off/)).toBeVisible()

    await reviewPage.goto(link)
    await expect(reviewPage.getByText('You can comment; you cannot edit')).toHaveCount(0)
    await reviewer.close()
  }
)

test('a forged review link shows nothing', async ({ app, page }) => {
  await app.open('/review/eyJmYWtlIjp0cnVlfQ~forged-signature-value')
  await expect(page.getByText('You can comment; you cannot edit')).toHaveCount(0)
})

test('Store screenshots is one click from any page, highlighted and titled, and old links land on it', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.open('/home')
  const sidebar = page.getByRole('complementary', { name: 'Primary navigation' })
  await sidebar.getByRole('link', { name: 'Store screenshots', exact: true }).click()
  await app.expectPath('/create/store')
  await expect(page.getByRole('button', { name: 'Use the sample set' })).toBeVisible()
  await expect(page).toHaveTitle('Store screenshots · Create | Shots')
  for (const name of ['Create', 'Store screenshots'])
    await expect(sidebar.getByRole('link', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )

  await page.getByRole('button', { name: 'Use the sample set' }).click()
  await expect(page).toHaveURL(/\/create\/store\/[^/]+$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(
    sidebar.getByRole('link', { name: 'Store screenshots', exact: true })
  ).toHaveAttribute('aria-current', 'page')

  await app.open(`/?project=abc&editor=app-store&storeProject=${id}`)
  await app.expectPath(`/create/store/${id}`)
  await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
  expect(new URL(page.url()).search).toBe('')
  await app.open('/?editor=app-store')
  await app.expectPath(`/create/store/${id}`)
  // The retired standalone page and its project links land in the same place.
  await app.open(`/store-screenshots?project=${id}`)
  await app.expectPath(`/create/store/${id}`)
  expect(new URL(page.url()).search).toBe('')
})

test('reopening the last project never reports an error the person did not cause', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.open('/create/store')
  await expect(page.getByRole('button', { name: 'Use the sample set' })).toBeVisible()
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('shots-store-studio', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['projects', 'meta'], 'readwrite')
      transaction.objectStore('projects').put({
        id: 'unreadable',
        name: 'Unreadable set',
        updatedAt: Date.now(),
        slideCount: 1,
        thumbnail: null,
        document: { version: 2, id: 'unreadable' },
      })
      transaction.objectStore('meta').put('unreadable', 'lastProjectId')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  })
  await app.reload()
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible()
  await expect(page.getByText('On this browser ·')).toBeVisible()
  await expect(page.getByText('Could not open the project')).toHaveCount(0)
  // Opening it on purpose still says why it cannot open.
  await page.getByRole('button', { name: /^Unreadable set/ }).click()
  await expect(page.getByText('Could not open the project')).toBeVisible()
})

test(
  'a project saved to the workspace autosaves there, lists in Library and opens on another browser',
  { tag: '@journey' },
  async ({ app, browser, identity, page }) => {
    await createWorkspace(identity, page)
    await app.open('/create/store')
    await page.getByRole('button', { name: 'Use the sample set' }).click()
    await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
    await editHeading(page, 'Saved everywhere')
    await page.getByRole('button', { name: 'Save to workspace', exact: true }).click()
    const saved = page.getByRole('status').filter({ hasText: /^Saved to workspace$/ })
    await expect(saved).toBeVisible({ timeout: 60_000 })
    const id = new URL(page.url()).pathname.split('/').pop()!

    const autosaved = page.waitForResponse(
      (response) => response.url().includes('storeProject.updateDocument') && response.ok()
    )
    await editHeading(page, 'Saved twice')
    await autosaved
    await expect(saved).toBeVisible()

    // A second browser profile has the session but none of this browser's projects.
    const other = await browser.newContext({ storageState: await page.context().storageState() })
    const second = await other.newPage()
    await second.goto(new URL('/library?type=store', page.url()).href)
    const library = second.getByRole('region', { name: 'Store screenshot projects' })
    const listed = library.locator(`a[href$="/create/store/${id}"][aria-label^="Open "]`)
    await expect(listed).toHaveCount(1)
    const name = (await listed.getAttribute('aria-label'))!.replace(/^Open /, '')
    await expect(library.getByText(/In this workspace/)).toBeVisible()
    await listed.click()
    await expect(second.locator('[data-store-canvas-slide]')).toContainText('Saved twice')
    await expect(
      second.getByRole('status').filter({ hasText: /^Saved to workspace$/ })
    ).toBeVisible()

    // Deleting the workspace copy takes it out of Library; this browser keeps its own copy.
    await second.goto(new URL('/library?type=store', page.url()).href)
    await library.getByRole('button', { name: `Actions for ${name}` }).click()
    await second.getByRole('menuitem', { name: 'Delete from workspace…' }).click()
    await second
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete from workspace' })
      .click()
    await expect(second.getByText(`Deleted “${name}” from the workspace.`)).toBeVisible()
    await expect(listed).toHaveCount(0)
    // This browser's own copy is still listed, now only under On this browser.
    await expect(library.locator(`a[href$="/create/store/${id}"]`)).toBeVisible()
    await other.close()

    // The first browser finds the copy gone instead of failing to save, and keeps its project.
    await app.reload()
    await expect(page.getByText('This project is no longer in your workspace')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save to workspace', exact: true })).toBeVisible()
    await expect(page.locator('[data-store-canvas-slide]')).toContainText('Saved twice')
  }
)

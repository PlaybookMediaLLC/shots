import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Page, test, trpcQuery } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const canvasText = (page: Page) =>
  page.locator('[data-html-canvas="true"]:visible [data-text-overlay-id]')

async function draftText(page: Page): Promise<string | undefined> {
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

test('bad images cannot block autosave, text remains editable, and playback and Back do not save', async ({
  app,
  page,
}) => {
  await app.openEditor()
  const buffer = await readFile(resolve('public/store-screenshot-create.png'))
  await page.getByLabel('Add slides', { exact: true }).setInputFiles([
    { buffer, mimeType: 'image/png', name: 'one.png' },
    { buffer, mimeType: 'image/png', name: 'two.png' },
  ])
  await expect(page.getByRole('button', { name: 'Select slide 2', exact: true })).toBeAttached()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  const content = page.getByRole('textbox', { name: 'Text content', exact: true })
  await content.click()
  await expect(content).toBeFocused()
  await content.fill('Saved headline')
  await page.getByRole('button', { name: 'Save as project', exact: true }).click()
  await page.getByLabel('Project name').fill('Editor QA project')
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  const saved = page.getByRole('button', {
    name: 'Project Editor QA project: Saved to workspace',
    exact: true,
  })
  await expect(saved).toBeVisible({ timeout: 30000 })
  const projectId = new URL(page.url()).searchParams.get('project')!

  await page.getByLabel('Add slides', { exact: true }).setInputFiles({
    buffer: Buffer.from('not a real image'),
    mimeType: 'image/png',
    name: 'broken.png',
  })
  await expect(
    page.getByText('broken.png is not a valid image/png image.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select slide 3', exact: true })).toHaveCount(0)
  await content.click()
  await content.fill('Still saving after a rejected image')
  await expect(saved).toBeVisible({ timeout: 30000 })
  await expect
    .poll(async () => {
      const result = await trpcQuery(page, 'project.get', { projectId })
      return (result.body as { document: { texts: { text: string }[] } }).document.texts[0]?.text
    })
    .toBe('Still saving after a rejected image')

  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('project.updateDocument')) writes++
  })
  // The timeline is closed until Animate opens it.
  await page.getByRole('button', { name: 'Animate', exact: true }).click()
  await page.getByRole('button', { name: 'Play animation', exact: true }).click()
  // eslint-disable-next-line no-restricted-syntax -- Playback runs on a clock: let it play, then prove it wrote nothing.
  await page.waitForTimeout(6500)
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click()
  expect(writes).toBe(0)
  await saved.click()
  await page.getByRole('menuitem', { name: 'All projects' }).click()
  await expect(page).toHaveURL(/\/library/)
  const reopened = page.waitForResponse((response) => response.url().includes('project.get'))
  await page.goBack()
  await reopened
  await expect(saved).toBeVisible({ timeout: 30000 })
  // Give the loader and debounced save enough time to expose a false recovery.
  // eslint-disable-next-line no-restricted-syntax -- Proves a false recovery never appears; an absence needs a window.
  await page.waitForTimeout(2000)
  await expect(canvasText(page)).toContainText('Still saving after a rejected image')
  await expect(page.getByText('Recovered your unsaved changes', { exact: true })).toHaveCount(0)
  expect(writes).toBe(0)
  await page.setViewportSize({ width: 1156, height: 900 })
  const projectBox = await saved.boundingBox()
  const undoBox = await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).boundingBox()
  if (projectBox && undoBox) expect(projectBox.x + projectBox.width).toBeLessThanOrEqual(undoBox.x)
  await page.screenshot({ path: '.context/editor-qa-fixed.png', animations: 'disabled' })
})

test('Remove keeps other slides and text, and screenshot upload remains available', async ({
  app,
  page,
}) => {
  await app.openEditor()
  const buffer = await readFile(resolve('public/store-screenshot-create.png'))
  await page.getByLabel('Add slides', { exact: true }).setInputFiles(
    ['one', 'two', 'three'].map((name) => ({
      buffer,
      mimeType: 'image/png',
      name: `${name}.png`,
    }))
  )
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  const content = page.getByLabel('Text content', { exact: true })
  await content.click()
  // One input event per character, all in one task. Real keystrokes on CI's dev
  // build took ~200ms each, and the burst split wherever the page stalled for
  // more than the 750ms typing window, so the test measured the runner, not grouping.
  await content.evaluate((node: HTMLTextAreaElement, text) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    for (let length = 1; length <= text.length; length += 1) {
      setValue.call(node, text.slice(0, length))
      node.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, 'One typing burst')
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(canvasText(page)).toHaveText('Text')
  await page.getByRole('button', { name: 'Redo (⌘⇧Z)', exact: true }).click()
  await expect(canvasText(page)).toHaveText('One typing burst')
  await page.getByRole('button', { name: 'Remove screenshot', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Select slide 3', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Select slide 2', exact: true })).toBeAttached()
  await page.getByRole('button', { name: 'Export Video', exact: true }).click()
  await page.getByRole('button', { name: /Slideshow/ }).click()
  const duration = page.getByRole('spinbutton', { name: 'Slide Duration', exact: true })
  await duration.fill('50')
  await expect(duration).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByRole('button', { name: /Export as MP4|Export as WEBM/ })).toBeDisabled()
  await duration.fill('')
  await expect(duration).toHaveValue('')
  await duration.fill('0.5')
  await duration.press('Tab')
  await expect(duration).toHaveValue('0.5')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Remove screenshot', exact: true }).click()
  await page.getByRole('button', { name: 'Remove screenshot', exact: true }).click()
  await expect(canvasText(page)).toHaveText('One typing burst')
  await expect(page.getByText('Upload image…', { exact: true })).toBeVisible()
  await page
    .getByLabel('Add slides', { exact: true })
    .setInputFiles({ buffer, mimeType: 'image/png', name: 'replacement.png' })
  await expect(page.getByRole('button', { name: 'Remove screenshot', exact: true })).toBeEnabled()
  await expect(canvasText(page)).toHaveText('One typing burst')
})

test('a stale tab cannot overwrite a newer local draft', async ({ app, page }) => {
  await app.openEditor()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  await page.getByLabel('Text content', { exact: true }).fill('Original draft')
  await expect.poll(() => draftText(page)).toBe('Original draft')
  const other = await page.context().newPage()
  await other.goto('/')
  await expect(canvasText(other)).toContainText('Original draft')
  await page.getByLabel('Text content', { exact: true }).fill('Newer draft from first tab')
  await expect.poll(() => draftText(page)).toBe('Newer draft from first tab')
  if (!(await other.getByLabel('Text content', { exact: true }).isVisible())) {
    await other.getByRole('button', { name: /^Edit text:/ }).click()
  }
  await other.getByLabel('Text content', { exact: true }).fill('Stale second tab edit')
  await expect(
    other.getByText('This draft was changed in another tab', { exact: true })
  ).toBeVisible()
  expect(await draftText(page)).toBe('Newer draft from first tab')
  await expect(canvasText(other)).toContainText('Stale second tab edit')
})

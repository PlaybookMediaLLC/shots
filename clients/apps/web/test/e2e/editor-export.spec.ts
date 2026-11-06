import { expect, type Page, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
)

async function uploadImage(page: Page) {
  const fileChooser = page.waitForEvent('filechooser')
  await page.getByText('Drag & drop, click to browse, or paste', { exact: true }).click()
  await (
    await fileChooser
  ).setFiles({
    buffer: image,
    mimeType: 'image/png',
    name: 'editor-e2e.png',
  })
  await expect(page.getByRole('button', { exact: true, name: 'Export' })).toBeEnabled()
}

test(
  'an authenticated user can upload an image and export a PNG',
  { tag: '@smoke' },
  async ({ app, page }) => {
    await app.openEditor()
    await uploadImage(page)

    const save = page.getByRole('button', { exact: true, name: 'Export' })
    await save.click()
    await page.getByRole('button', { exact: true, name: 'PNG' }).click()
    const exportButton = page.getByRole('button', { name: 'Export as PNG' })
    await expect(exportButton).toBeVisible()

    const download = page.waitForEvent('download')
    await exportButton.click()
    expect((await download).suggestedFilename()).toMatch(/\.png$/)
  }
)

test('an authenticated user can prepare a social aspect ratio, style it, and clear the draft', async ({
  app,
  page,
}) => {
  await app.openEditor()
  await uploadImage(page)

  await page.getByRole('button', { exact: true, name: '4:3' }).click()
  await page.getByRole('button', { name: /Post\s+1:1/ }).click()
  await expect(page.getByRole('banner').getByRole('button', { name: /1:1/ })).toBeVisible()

  await page.getByRole('button', { exact: true, name: 'BG' }).click()
  await expect(page.getByText('Custom Background', { exact: true })).toBeVisible()
  await page.getByRole('button', { exact: true, name: 'Transparent' }).click()

  await page.getByRole('button', { exact: true, name: 'Remove screenshot' }).click()
  await expect(
    page.getByText('Drag & drop, click to browse, or paste', { exact: true })
  ).toBeVisible()
})

test(
  'Use in post opens a draft with the design attached',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await uploadImage(page)
    await page.getByRole('button', { exact: true, name: 'Export' }).click()
    await page.getByRole('button', { exact: true, name: 'PNG' }).click()
    await page.getByRole('button', { exact: true, name: 'Use in post' }).click()
    await page.waitForURL((url) => /^\/publish\/[a-z0-9]+$/.test(url.pathname), { timeout: 90_000 })
    await expect(page.getByTestId('media-strip-item')).toHaveCount(1, { timeout: 60_000 })
    await expect(
      page.getByRole('textbox', { name: 'Draft body' }).locator('img[src*="/api/v1/assets/"]')
    ).toHaveCount(1)
  }
)

test(
  'text can be typed on the canvas, and exports as typed',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await page.getByRole('button', { exact: true, name: 'Start with text' }).click()
    const field = page.getByRole('textbox', { name: 'Edit text', exact: true })
    await expect(field).toBeFocused()
    // Backspace edits the words; it must not reach the canvas shortcut that deletes the layer.
    await page.keyboard.type('Launch day')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape')
    await expect(field).toHaveCount(0)
    const layer = page.locator('[data-text-overlay-id]')
    await expect(layer).toHaveText('Launch da')

    // Double-click opens it again, without starting a drag.
    const before = await layer.boundingBox()
    await layer.dblclick()
    await expect(field).toBeFocused()
    await page.keyboard.type('Ship it')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(layer).toHaveText('Ship it')
    expect(Math.abs((await layer.boundingBox())!.y - before!.y)).toBeLessThan(2)

    await page.getByRole('button', { exact: true, name: 'Export' }).click()
    await page.getByRole('button', { exact: true, name: 'PNG' }).click()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: /^Export as PNG/ }).click()
    expect((await download).suggestedFilename()).toMatch(/\.png$/)
  }
)

test(
  'a design is saved to the workspace on leaving the editor',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await uploadImage(page)
    await page.getByRole('link', { name: 'Library', exact: true }).first().click()
    await expect(page).toHaveURL(/\/library/)
    await expect(page.getByText('Untitled screenshot', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    })
  }
)

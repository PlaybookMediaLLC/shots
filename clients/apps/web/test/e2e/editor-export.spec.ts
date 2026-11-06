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

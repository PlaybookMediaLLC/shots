import { expect, type Page, test } from './framework'
import sharp from 'sharp'

test.use({ workspaceOptions: { plan: 'pro' } })

async function dropScreenshot(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')!
    context.fillStyle = '#2563eb'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((png) => resolve(png!), 'image/png')
    )
    const data = new DataTransfer()
    data.items.add(new File([blob], 'launch.png', { type: 'image/png' }))
    document
      .querySelector('[data-local-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('img[alt="Main image"]')).toHaveCount(1)
}

test(
  'a published design opens for anyone, previews, embeds, can be restricted, and revoked',
  { tag: '@smoke' },
  async ({ app, browser, page }) => {
    test.setTimeout(480_000)
    await app.openEditor()
    await dropScreenshot(page)

    await page.getByRole('button', { exact: true, name: 'Share' }).click()
    const dialog = page.getByRole('dialog', { name: 'Share design' })
    await dialog.getByLabel('Title').fill('Launch preview')
    await dialog.getByLabel('Description').fill('The new dashboard, ready for review.')
    await dialog.getByLabel('Alt text').fill('A blue dashboard screenshot')
    await dialog.getByRole('button', { name: 'Anyone with the link', exact: true }).click()
    await dialog.getByRole('button', { name: 'Publish link' }).click()
    const published = page.getByRole('dialog', { name: 'Published' })
    await expect(published).toBeVisible({ timeout: 60_000 })
    const url = await published.getByLabel('Link').inputValue()
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/)
    await expect(published.getByLabel('Embed code')).toHaveValue(new RegExp(`src="${url}/embed"`))
    await expect(published.getByText(/Connect Slack, Notion, or Figma/)).toBeVisible()

    // Anyone with the link sees the image, and link previews read its tags.
    const visitor = await browser.newContext()
    const anonymous = await visitor.newPage()
    await anonymous.goto(url)
    await expect(anonymous.getByRole('img', { name: 'A blue dashboard screenshot' })).toBeVisible()
    await expect(anonymous.getByRole('heading', { name: 'Launch preview' })).toBeVisible()
    const ogImage = await anonymous.locator('meta[property="og:image"]').getAttribute('content')
    expect(ogImage).toMatch(/\/api\/share\/[A-Za-z0-9_-]+\/media$/)
    expect(await anonymous.locator('meta[property="og:title"]').getAttribute('content')).toBe(
      'Launch preview'
    )
    expect(await anonymous.locator('meta[name="robots"]').getAttribute('content')).toContain(
      'noindex'
    )
    const media = await anonymous.request.get(new URL(new URL(ogImage!).pathname, url).toString())
    expect(media.status()).toBe(200)
    // The link publishes the design in the current export format.
    const { format, height, width } = await sharp(await media.body()).metadata()
    expect(media.headers()['content-type']).toBe(`image/${format}`)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
    await anonymous.goto(`${url}/embed`)
    await expect(anonymous.getByRole('img', { name: 'A blue dashboard screenshot' })).toBeVisible()
    await published.getByRole('button', { name: 'Done' }).click()

    // Limit it to the workspace: visitors are turned away, members still see it.
    await app.open('/workspace/shared-links')
    const row = page
      .getByText('Launch preview')
      .locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    await row.getByRole('button', { name: 'Limit to workspace' }).click()
    await expect(row.getByRole('button', { name: 'Allow anyone' })).toBeVisible()
    await anonymous.goto(url)
    await expect(anonymous.getByRole('heading', { name: 'Shared with a workspace' })).toBeVisible()
    expect(
      (await anonymous.request.get(new URL(new URL(ogImage!).pathname, url).toString())).status()
    ).toBe(403)
    await page.goto(url)
    await expect(page.getByRole('img', { name: 'A blue dashboard screenshot' })).toBeVisible()

    // Revoke it: the link is gone for everyone.
    await app.open('/workspace/shared-links')
    await page.getByRole('button', { name: 'Revoke Launch preview' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke link' }).click()
    await expect(page.getByText('Revoked', { exact: true })).toBeVisible()
    await anonymous.goto(url)
    await expect(
      anonymous.getByRole('heading', { name: 'This link is not available' })
    ).toBeVisible()
    expect(
      (await anonymous.request.get(new URL(new URL(ogImage!).pathname, url).toString())).status()
    ).toBe(404)
    await visitor.close()
  }
)

test('integrations say exactly what a server needs before they can connect', async ({
  app,
  page,
}) => {
  await app.open('/workspace/integrations')
  for (const provider of ['Slack', 'Notion', 'Figma']) {
    await expect(page.getByRole('heading', { name: provider })).toBeVisible()
  }
  const slackSetup = page
    .locator('[data-slot="disclosure"]')
    .filter({ hasText: 'backend Slack configuration' })
  await slackSetup.getByText('Administrator setup details', { exact: true }).click()
  await expect(slackSetup.getByText('backend Slack configuration', { exact: true })).toBeVisible()
  const connect = await page.request.get('/api/integrations/slack/connect', { maxRedirects: 0 })
  expect(connect.status()).toBe(503)
  expect(await connect.text()).toContain('backend Slack configuration')
  const forged = await page.request.get('/api/integrations/slack/callback?code=x&state=forged', {
    maxRedirects: 0,
  })
  expect(forged.status()).toBe(302)
  expect(forged.headers().location).toContain('error=')
})

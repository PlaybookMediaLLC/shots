import { readFile, stat } from 'node:fs/promises'
import { createWorkspace, expect, png, test } from './framework'

// The app's server-side fetch allowlist must include this fixture host before startup.
const source = process.env.E2E_LINK_PREVIEW_SOURCE ?? 'http://screenshot-mock:5678'
const first = `${source}/link-preview/one`
const second = `${source}/link-preview/two`

test('batch drill-ins preserve results without fetching again, and compare swaps its results', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.open('/publish/link-checks')
  await expect(page.getByText('Testing localhost')).toHaveCount(0)
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Check again')
  await page.keyboard.press('Escape')
  let requests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/link-preview') requests++
  })
  await page.getByRole('button', { name: 'Batch', exact: true }).click()
  const links = page.getByLabel('Links to check')
  await links.fill(`${first}\nnot a url\n${second}`)
  await expect(page.getByRole('alert').filter({ hasText: 'Invalid URL lines' })).toContainText(
    'not a url'
  )
  await expect(page.getByRole('button', { name: 'Check all' })).toBeDisabled()
  expect(requests).toBe(0)
  await links.fill(`${first}\n${second}`)
  await page.getByRole('button', { name: 'Check all' }).click()
  await expect(page.getByText(/Results · 2 checked, 0 failed/)).toBeVisible()
  const rows = await page.locator('tbody').innerText()
  await page.locator('tbody button').first().click()
  await expect(page.getByRole('tab', { name: 'Result' })).toBeVisible()
  await page.getByRole('button', { name: 'Batch', exact: true }).click()
  await expect(links).toHaveValue(`${first}\n${second}`)
  await expect(page.locator('tbody')).toHaveText(rows, { useInnerText: true })
  expect(requests).toBe(2)

  await page.getByRole('button', { name: 'Compare', exact: true }).first().click()
  await expect(page.getByLabel('First URL')).toHaveValue(first)
  await page.getByLabel('Second URL').fill(second)
  await page.getByRole('button', { name: 'Compare', exact: true }).last().click()
  const titleRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: /^Title/ }) })
  await expect(titleRow.getByRole('cell').nth(1)).toContainText('First page')
  await page.getByRole('button', { name: 'Swap', exact: true }).click()
  await expect(page.getByLabel('First URL')).toHaveValue(second)
  await expect(titleRow.getByRole('cell').nth(1)).toContainText('Second page')
  expect(requests).toBe(4)
})

test(
  'image and share edits survive tabs, saving, Escape, and reload',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    // The metadata server resolves this Docker hostname; the host-side browser cannot.
    await page.route(`${source}/image`, async (route) => {
      expect(route.request().method()).toBe('GET')
      await route.fulfill({ body: png, contentType: 'image/png' })
    })
    await page.route(`${source}/link-preview/broken-image`, async (route) => {
      expect(route.request().method()).toBe('GET')
      await route.fulfill({ status: 404, body: '' })
    })
    await createWorkspace(identity, page)
    await app.open(`/publish/link-checks?url=${encodeURIComponent(first)}`)
    await page.getByRole('tab', { name: 'Images', exact: true }).click()
    await page.getByLabel('Headline', { exact: true }).fill('TEST HEADLINE 123')
    await page.getByRole('button', { name: 'Paper colors' }).click()
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    const canvas = page.getByLabel('Generated preview image')
    const rendered = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())
    await page.getByRole('button', { name: 'Preview on every platform' }).click()
    await page.getByRole('tab', { name: 'Basic', exact: true }).click()
    await page.getByRole('tab', { name: 'Images', exact: true }).click()
    await expect(page.getByLabel('Headline', { exact: true })).toHaveValue('TEST HEADLINE 123')
    await expect(page.getByRole('button', { name: 'Paper colors' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).toBe(rendered)
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download JPEG' }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toMatch(/split-preview\.jpg$/)
    expect((await stat((await download.path())!)).size).toBeLessThanOrEqual(600 * 1024)
    const saved = page.waitForResponse(
      (response) => response.url().includes('asset.completeUpload') && response.ok()
    )
    await page.getByRole('button', { name: 'Save to workspace' }).click()
    const completed = await (await saved).json()
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible()
    const assetId = completed[0].result.data.json.asset.id
    const storedImage = await page.request.get(`/api/v1/assets/${assetId}/content`)
    expect(storedImage.ok()).toBe(true)
    expect(await storedImage.body()).toEqual(await readFile((await download.path())!))

    await page.getByRole('tab', { name: 'Fix', exact: true }).click()
    await page.getByLabel('Title', { exact: false }).first().fill('My fixed title')
    await page.getByLabel('Image URL').fill(`${source}/link-preview/broken-image`)
    await expect(page.getByLabel('No image', { exact: true })).toBeVisible()
    await page.getByLabel('Image URL').fill(`${source}/image`)
    await expect(page.getByRole('img', { name: 'My fixed title', exact: true })).toBeVisible()
    await expect(page.getByRole('img', { name: 'My fixed title', exact: true })).toHaveJSProperty(
      'naturalWidth',
      1
    )
    await page.getByRole('heading', { name: 'Link checks', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByLabel('Title', { exact: false }).first()).toHaveValue('My fixed title')
    await page.getByLabel('Image URL').fill('javascript:alert(1)')
    await expect(page.getByLabel('Image URL')).toHaveAttribute('aria-invalid', 'true')
    await expect(
      page.getByText('og:image needs a public http(s) URL', { exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(page.getByRole('img', { name: 'First page', exact: true })).toBeVisible()

    await page.getByRole('tab', { name: 'Previews', exact: true }).click()
    await page.getByRole('textbox', { name: /Post text/ }).fill('Launch 🚀')
    await page.getByRole('tab', { name: 'Share', exact: true }).click()
    await page.getByLabel('Campaign (utm_campaign)').fill('Fall Launch & Promo #1')
    await page.getByLabel(/Variant \(utm_content/).fill('hero/v2?x=1')
    await app.reload()
    await expect(page.getByRole('tab', { name: 'Share', exact: true })).toHaveAttribute(
      'data-state',
      'active'
    )
    await expect(page.getByLabel(/Campaign \(utm_campaign/)).toHaveValue('Fall Launch & Promo #1')
    await expect(page.getByLabel(/Variant \(utm_content/)).toHaveValue('hero/v2?x=1')
    await page.getByRole('tab', { name: 'Previews', exact: true }).click()
    await expect(page.getByRole('textbox', { name: /Post text/ })).toHaveValue('Launch 🚀')
    await page.getByRole('heading', { name: 'Link checks', exact: true }).click()
    await page.keyboard.press('[')
    await expect(page.getByRole('tab', { name: 'Reddit', exact: true })).toHaveAttribute(
      'data-state',
      'active'
    )
    await page.keyboard.press(']')
    await expect(page.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute(
      'data-state',
      'active'
    )
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByText('Swipe for more platforms →')).toBeVisible()
    await page.getByRole('tab', { name: 'Share', exact: true }).click()
    const tracked = page.locator('code').filter({ hasText: 'utm_campaign=' }).first()
    await expect(tracked).toBeVisible()
    expect(await tracked.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.setViewportSize({ width: 1280, height: 720 })

    await page.getByRole('combobox').first().click()
    await page.getByRole('option', { name: /Facebook/ }).click()
    await expect(
      page.getByRole('status').filter({ hasText: 'Results are for Preview bot' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Re-run with Facebook' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Results are for' })).toHaveCount(0)
    await expect(page).toHaveURL(/agent=facebook/)
    await page.getByRole('button', { name: 'Clear', exact: true }).first().click()
    await expect(page).toHaveURL(/\/publish\/link-checks$/)
  }
)

test('invalid automation input cannot produce a script, and error pages still have reports', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.open(`/publish/link-checks?url=${encodeURIComponent(`${source}/link-preview/missing`)}`)
  await expect(page.getByText('The page returns HTTP 404', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Automate', exact: true }).click()
  const copy = page.getByRole('button', { name: 'Copy', exact: true })
  await page.getByLabel('Fail below score').fill('')
  await expect(copy).toBeDisabled()
  await page.getByLabel('Fail below score').fill('80')
  await page.getByLabel('Links to check, one per line').fill('not a url')
  await expect(copy).toBeDisabled()
  await page.getByLabel('Links to check, one per line').fill(first)
  await expect(copy).toBeEnabled()
})

test('link preview reports require a signed-in workspace', async ({ page }) => {
  const response = await page.request.get(`/api/v1/link-preview?url=${encodeURIComponent(first)}`)
  expect(response.status()).toBe(401)
})

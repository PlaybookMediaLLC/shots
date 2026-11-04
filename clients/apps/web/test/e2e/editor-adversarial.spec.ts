import { resolve } from 'node:path'
import { createWorkspace, type E2EIdentity, expect, type Page, test } from './framework'

test('an element-only composition stays visible and can export after its last text is removed', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.openEditor()
  await page.getByRole('button', { name: 'Step badge', exact: true }).click()
  const canvas = page.locator('[data-html-canvas="true"]:visible')
  await expect(canvas).toBeVisible()
  await expect(canvas.locator('[data-element-id]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  await page.getByRole('button', { name: 'Delete text', exact: true }).click()
  await expect(canvas).toBeVisible()
  await expect(canvas.locator('[data-element-id]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Remove screenshot', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('button', { name: 'PNG', exact: true }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export as PNG', exact: true }).click()
  expect(await (await download).path()).toBeTruthy()
})

async function openStore(identity: E2EIdentity, page: Page) {
  await createWorkspace(identity, page)
  await page.goto('/create/store')
  await page.getByRole('button', { name: 'Use the sample set' }).click()
  await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
}

test('background replacements and uploaded-image removal undo in one step', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.openEditor()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  await page.getByRole('button', { name: 'BG', exact: true }).click()
  const bg = page.getByRole('tabpanel', { name: 'BG', exact: true })
  await bg
    .locator('input[type="file"]')
    .setInputFiles(resolve('public/store-screenshot-create.png'))
  const image = bg.getByRole('img', { name: 'Background', exact: true })
  await expect(image).toBeVisible()
  const src = await image.getAttribute('src')
  await bg.getByRole('button', { name: 'Magic gradient magic amber center', exact: true }).click()
  await expect(image).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(image).toHaveAttribute('src', src!)
  await page.getByRole('button', { name: 'Redo (⌘⇧Z)', exact: true }).click()
  await expect(image).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await bg.getByRole('button', { name: 'Remove background image', exact: true }).click()
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(image).toHaveAttribute('src', src!)
  // Reload the same URL to prove Undo did not merely retain already decoded pixels.
  expect(await page.evaluate(async (url) => (await fetch(url!)).ok, src)).toBe(true)
  await bg.getByRole('button', { name: 'Transparent', exact: true }).click()
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(image).toHaveAttribute('src', src!)
  await bg.getByRole('button', { name: 'Shadow 1', exact: true }).click()
  const shadow = page
    .locator('[data-html-canvas="true"]:visible')
    .getByRole('img', { name: 'Shadow overlay', exact: true })
  await expect(shadow).toBeVisible()
  const firstShadow = await shadow.getAttribute('src')
  await bg.getByRole('button', { name: 'Shadow 2', exact: true }).click()
  await expect(shadow).not.toHaveAttribute('src', firstShadow!)
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(shadow).toHaveAttribute('src', firstShadow!)
})

test('gradient Escape discards drafts and canvas sizing rejects invalid whole pixels', async ({
  app,
  identity,
  page,
}) => {
  await createWorkspace(identity, page)
  await app.openEditor()
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Undo')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Keyboard shortcuts', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'BG', exact: true }).click()
  const hex = page.getByRole('textbox', { name: 'From gradient hex code', exact: true })
  const initial = await hex.inputValue()
  await hex.fill('#123456')
  await hex.press('Escape')
  await expect(hex).toHaveValue(initial)
  await hex.fill('#123456')
  await hex.press('Enter')
  await expect(hex).toHaveValue('#123456')
  await page.getByRole('button', { name: 'Undo (⌘Z)', exact: true }).click()
  await expect(hex).toHaveValue(initial)
  await page.getByRole('button', { name: '4:3', exact: true }).click()
  const width = page.getByRole('spinbutton', { name: 'Canvas width', exact: true })
  for (const invalid of ['', '0', '-10', '1.5', '999999']) {
    await width.fill(invalid)
    await expect(width).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByRole('button', { name: 'Set', exact: true })).toBeDisabled()
    await expect(page.getByRole('alert').filter({ hasText: 'Use whole pixels' })).toBeVisible()
  }
  await width.fill('1200')
  await page.getByRole('spinbutton', { name: 'Canvas height', exact: true }).fill('900')
  await width.press('Enter')
  await expect(page.getByRole('button', { name: '1200 × 900', exact: true })).toBeVisible()
})

test(
  'App Store numeric cancellation, bulk undo, duplication and crop cancellation stay consistent',
  { tag: '@journey' },
  async ({ identity, page }, testInfo) => {
    await openStore(identity, page)
    const slides = page.getByRole('listbox', { name: 'Slides', exact: true })
    await slides.getByRole('option').first().click()
    await slides
      .getByRole('option')
      .nth(2)
      .click({ modifiers: ['Shift'] })
    const from = page.getByRole('textbox', { name: 'From', exact: true })
    const before = await from.inputValue()
    const angle = page.getByRole('textbox', { name: 'Angle (°)', exact: true })
    const beforeAngle = await angle.inputValue()
    await angle.fill('270')
    await angle.press('Escape')
    await expect(angle).toHaveValue(beforeAngle)
    await page.getByRole('button', { name: 'Mint background', exact: true }).click()
    await expect(from).toHaveValue('#d1fae5')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(from).toHaveValue(before)
    await page.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(from).toHaveValue('#d1fae5')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.getByRole('button', { name: 'Use project background', exact: true }).click()
    const inherited = await from.inputValue()
    await page.getByRole('button', { name: 'Mint background', exact: true }).click()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(from).toHaveValue(inherited)
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
    const count = await slides.getByRole('option').count()
    await page.getByRole('button', { name: 'Duplicate slide', exact: true }).click()
    await expect(slides.getByRole('option')).toHaveCount(count + 1)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(slides.getByRole('option')).toHaveCount(count)
    await page.getByRole('option', { name: /^Device Hide Device Lock Device/ }).click()
    await expect(
      page.getByText('Fills the device screen. Image edges may be cropped.')
    ).toBeVisible()
    await page.getByRole('button', { name: 'Crop on canvas', exact: true }).click()
    await page.getByRole('button', { name: 'Zoom screenshot in', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Fill', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: 'Fit', exact: true }).click()
    await expect(
      page.getByText('Shows the whole screenshot. Empty space may appear around it.')
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('store-fit.png') })
  }
)

test(
  'Checks and header count follow export selection; mobile duplicate and preview remain usable',
  { tag: '@journey' },
  async ({ identity, page }) => {
    await openStore(identity, page)
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Export screenshots', exact: true })
    await dialog.getByRole('checkbox', { name: /^iPhone 6\.9/ }).uncheck()
    await dialog.getByRole('checkbox', { name: /^iPhone 6\.3/ }).uncheck()
    await dialog.getByRole('checkbox', { name: /^Play phone/ }).check()
    const choices = dialog.getByRole('group', { name: /^Slides/ })
    for (const button of await choices.getByRole('button', { name: /^\d+$/ }).all()) {
      if ((await button.innerText()) !== '1') await button.click()
    }
    await expect(choices).toContainText('1 of 8')
    const exportIssues = await dialog
      .locator('p')
      .filter({ hasText: /store requirement issues|design suggestions/ })
      .innerText()
    const expected = [
      ...exportIssues.matchAll(/(\d+) (?:store requirement issues|design suggestions)/g),
    ].reduce((n, match) => n + Number(match[1]), 0)
    await dialog.getByRole('button', { name: 'Review', exact: true }).click()
    const checks = page.getByRole('dialog', { name: 'Checks', exact: true })
    await expect(checks).toContainText('1 slide for Play phone')
    await expect(checks).not.toContainText('iPhone 6.9"')
    const totals = await checks.getByRole('heading', { level: 3 }).allTextContents()
    expect(totals.reduce((n, text) => n + Number(text.match(/\((\d+)\)/)?.[1] ?? 0), 0)).toBe(
      expected
    )
    await checks.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(
      page.getByRole('button', { name: `Checks ${expected}`, exact: true })
    ).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    const duplicate = page.getByRole('button', { name: 'Duplicate slide', exact: true })
    await expect(duplicate).toBeVisible()
    const rect = (await duplicate.boundingBox())!
    expect(rect.x + rect.width).toBeLessThanOrEqual(390)
    await page.getByRole('button', { name: 'Store preview', exact: true }).click()
    await page.getByRole('tab', { name: 'Google Play listing', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('horizontal gallery')
    await expect(page.getByRole('dialog')).not.toContainText('Search results show')
  }
)

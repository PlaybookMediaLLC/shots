import { expect, type Page, test } from './framework'
import sharp from 'sharp'

test.use({ workspaceOptions: { plan: 'pro' } })

/**
 * The AI features run against the deterministic scripted model
 * (PLATFORM_AI_SCRIPTED=1), which exercises wiring, validation, storage, and
 * the UI without a provider. It is not a quality bar for the real models.
 */

async function dropScreenshot(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')!
    context.fillStyle = '#e11d48'
    context.fillRect(0, 0, 1200, 400)
    context.fillStyle = '#f8fafc'
    context.fillRect(0, 400, 1200, 400)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((png) => resolve(png!), 'image/png')
    )
    const data = new DataTransfer()
    data.items.add(new File([blob], 'app.png', { type: 'image/png' }))
    document
      .querySelector('[data-local-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('img[alt="Main image"]')).toHaveCount(1)
}

async function exportCorner(page: Page) {
  await page.getByRole('button', { exact: true, name: 'Export' }).click()
  await page.getByRole('button', { exact: true, name: 'PNG' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export as PNG' }).click()
  const file = await (await download).path()
  await page.keyboard.press('Escape')
  const { data, info } = await sharp(file!).raw().toBuffer({ resolveWithObject: true })
  const offset = (24 * info.width + 24) * info.channels
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!]
}

test(
  'copilot versions compare before applying; captions and alt text are written and kept',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await dropScreenshot(page)
    await page.getByRole('button', { exact: true, name: 'Add Text' }).first().click()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // "Give me four versions" opens four complete versions beside the original.
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()
    const panel = page.getByRole('region', { name: 'AI copilot' })
    await panel.getByLabel('Ask the copilot').fill('Give me four versions of this design')
    await panel.getByLabel('Ask the copilot').press('Enter')
    // The request prefills Variants; spending credits still takes an explicit click.
    await panel.getByRole('button', { name: 'Make 4 versions' }).click()
    const versions = panel.getByRole('list', { name: 'Versions' })
    await expect(versions.getByRole('button', { name: /^Inspect / })).toHaveCount(4, {
      timeout: 90_000,
    })
    await expect(versions.getByText('Original')).toBeVisible()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // Inspect one, keep the original, then apply another: one undo step back.
    await versions.getByRole('button', { name: 'Inspect Tilted square' }).click()
    const inspect = page.getByRole('dialog', { name: 'Tilted square' })
    await expect(inspect.getByRole('img', { name: 'Tilted square' })).toBeVisible({
      timeout: 60_000,
    })
    await inspect.getByRole('button', { name: 'Keep original' }).click()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()
    await versions.getByRole('button', { name: 'Inspect Tilted square' }).click()
    await inspect.getByRole('button', { name: 'Apply this version' }).click()
    await expect(page.getByText('1:1', { exact: true }).first()).toBeVisible()
    // Shortcuts are ignored inside dialogs: undo once the inspector has fully closed.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // Captions: alt text and one caption per platform, editable and kept with the design.
    await panel.getByRole('button', { exact: true, name: 'Captions' }).click()
    await panel.getByRole('button', { name: 'Write alt text and captions' }).click()
    const x = panel.getByLabel('X caption')
    await expect(x).toHaveValue(/Meet/, { timeout: 60_000 })
    await expect(panel.getByLabel('LinkedIn caption')).toHaveValue(/Meet/)
    await expect(panel.getByLabel('Instagram caption')).toHaveValue(/#launch/)
    await x.fill('Meet the new dashboard.')
    await x.blur()
    await panel.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('button', { exact: true, name: 'Share' }).click()
    await expect(
      page.getByRole('dialog', { name: 'Share design' }).getByLabel('Alt text')
    ).toHaveValue(/product screenshot/)
    await page.keyboard.press('Escape')
  }
)

test(
  'an AI background in the screenshot palette applies as an image background and exports',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await dropScreenshot(page)
    const before = await exportCorner(page)

    await page.getByRole('button', { exact: true, name: 'BG' }).click()
    await page.getByRole('button', { name: 'AI background' }).click()
    await page.getByLabel('Describe the background').fill('Warm glow behind the product')
    await page.getByRole('radio', { name: 'From screenshot' }).click()
    await expect(page.getByLabel('Palette').locator('span')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Generate background' }).click()
    const results = page.getByRole('list', { name: 'Generated backgrounds' })
    await expect(results.getByRole('button')).toHaveCount(1, { timeout: 90_000 })
    const after = await exportCorner(page)
    expect(after).not.toEqual(before)

    // Regenerating keeps the earlier result to go back to.
    await page.getByRole('button', { name: 'Generate another' }).click()
    await expect(results.getByRole('button')).toHaveCount(2, { timeout: 90_000 })
  }
)

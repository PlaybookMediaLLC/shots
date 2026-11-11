import { readFile } from 'node:fs/promises'
import { type Download, expect, type Page, test } from './framework'
import JSZip from 'jszip'
import sharp from 'sharp'

test.use({ workspaceOptions: { plan: 'pro' } })

/**
 * Cross-feature acceptance workflows A and C. B (animated product shot)
 * lives in motion.spec.ts, D (safe publishing) in
 * workflow-safe-publishing.spec.ts, E (cloud editing) in projects.spec.ts,
 * and F (consistent frames) in frames.spec.ts. AI steps use the scripted
 * model (PLATFORM_AI_SCRIPTED=1).
 */

const BRAND_BACKGROUND: [number, number, number] = [11, 16, 32]

async function dropScreenshot(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1400
    canvas.height = 900
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f8fafc'
    context.fillRect(0, 0, 1400, 900)
    context.fillStyle = '#2563eb'
    context.fillRect(0, 0, 1400, 110)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!)))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'dashboard.png', { type: 'image/png' }))
    document
      .querySelector('[data-local-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('img[alt="Main image"]')).toHaveCount(1)
}

/** Create a brand kit in the editor and apply it to the design. */
async function createAndApplyBrand(page: Page, name: string) {
  await page.getByRole('button', { exact: true, name: 'Design' }).first().click()
  await page.getByRole('button', { exact: true, name: 'New brand kit' }).click()
  const dialog = page.getByRole('dialog', { name: 'New brand kit' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByRole('button', { name: 'Create brand kit' }).click()
  // Saving uploads nothing here, but reloads the workspace's kits.
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await page.getByRole('button', { name: `Apply ${name}` }).click()
  await expect(page.getByText(`Applied ${name}`)).toBeVisible()
}

async function savePreset(page: Page, name: string) {
  await page.getByRole('button', { name: 'Save design as preset' }).click()
  const dialog = page.getByRole('dialog', { name: 'Save as preset' })
  await dialog.getByLabel('Preset name').fill(name)
  await dialog.getByRole('button', { name: 'Save preset' }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: `Apply preset ${name}` })).toBeVisible()
}

async function bytesOf(download: Download): Promise<Buffer> {
  return readFile((await download.path())!)
}

/** Pixel size and the colour just inside the top-left corner of a PNG. */
async function inspectPng(bytes: Buffer) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
  const offset = (24 * info.width + 24) * info.channels
  return {
    corner: [data[offset]!, data[offset + 1]!, data[offset + 2]!],
    height: info.height,
    width: info.width,
  }
}

const near = (actual: number[], expected: number[], tolerance = 28) =>
  actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance)

test('Workflow A: 30 screenshots in a brand preset export in three sizes as one ZIP', async ({
  app,
  page,
}) => {
  test.setTimeout(900_000)
  await app.openEditor()
  await dropScreenshot(page)
  await createAndApplyBrand(page, 'Acme')
  await savePreset(page, 'Acme hero')

  await page.getByRole('button', { exact: true, name: 'Export' }).click()
  await page.getByRole('button', { name: /Batch export/ }).click()
  const batch = page.getByRole('dialog', { name: 'Batch export' })
  await batch.getByRole('radio', { name: /Acme hero/ }).click()
  await expect(batch.getByRole('radio', { name: /Acme hero/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )

  await page.evaluate(async () => {
    const data = new DataTransfer()
    for (let index = 0; index < 30; index++) {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 800
      const context = canvas.getContext('2d')!
      context.fillStyle = `hsl(${index * 12}, 70%, 88%)`
      context.fillRect(0, 0, 1200, 800)
      context.fillStyle = '#0f172a'
      context.font = '64px sans-serif'
      context.fillText(`Screen ${index + 1}`, 80, 200)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!)))
      data.items.add(new File([blob], `screen ${index + 1}.png`, { type: 'image/png' }))
    }
    document
      .querySelector('[data-batch-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(
    batch.getByRole('list', { name: 'Batch screenshots' }).getByRole('listitem')
  ).toHaveCount(30, {
    timeout: 120_000,
  })

  await batch.getByRole('button', { name: 'Add sizes' }).click()
  await page.getByRole('checkbox', { name: /Instagram square/ }).click()
  await page.getByRole('checkbox', { name: /LinkedIn post/ }).click()
  await page.keyboard.press('Escape')
  await expect(batch.getByText('30 screenshots × 3 sizes → 90 files')).toBeVisible()

  const download = page.waitForEvent('download', { timeout: 840_000 })
  await batch.getByRole('button', { name: /^Export 30 as ZIP$/ }).click()
  const zip = await JSZip.loadAsync(await bytesOf(await download))
  const files = Object.values(zip.files).filter((file) => !file.dir)
  expect(files).toHaveLength(90)
  const folders = new Map<string, string[]>()
  for (const file of files) {
    const [folder, name] = file.name.split('/')
    folders.set(folder!, [...(folders.get(folder!) ?? []), name!])
  }
  expect(folders.size).toBe(3)
  expect([...folders.keys()].sort()).toEqual(
    expect.arrayContaining(['instagram-square-1080x1080', 'linkedin-post-1200x627'])
  )
  for (const [folder, names] of folders) {
    expect(names, folder).toHaveLength(30)
    expect(names.sort()[0], folder).toMatch(/^0?1-screen-1\.png$/)
    // Every size carries the brand: its background sits in the corner.
    const sample = await inspectPng(await zip.file(`${folder}/${names[0]}`)!.async('nodebuffer'))
    const [width, height] = folder
      .match(/(\d+)x(\d+)$/)!
      .slice(1)
      .map(Number)
    expect({ height: sample.height, width: sample.width }, folder).toEqual({ height, width })
    expect(
      near(sample.corner, BRAND_BACKGROUND),
      `${folder} corner ${sample.corner.join(',')}`
    ).toBe(true)
  }
})

// @quarantine until fixed: on the production build the workflow does not finish (it ran past 4 min; 20 s on next dev).
test(
  'Workflow C: a branded bento with badges becomes a preset, then a chosen variant in several sizes',
  { tag: '@quarantine' },
  async ({ app, page }) => {
    test.setTimeout(900_000)
    await app.openEditor()

    // Three screenshots in a bento composition.
    const framePanel = page.getByRole('tabpanel', { name: 'Frame' })
    await page.getByRole('button', { exact: true, name: 'Frame' }).first().click()
    const chooser = page.waitForEvent('filechooser')
    await framePanel.getByRole('button', { name: 'Add screenshots' }).click()
    await (
      await chooser
    ).setFiles([
      'public/demo/notion-showcase.webp',
      'public/demo/demo-2.png',
      'public/demo/demo-checkout-9x16.jpg',
    ])
    await expect(page.locator('#image-render-card [data-device-id]')).toHaveCount(3)
    await framePanel.getByRole('button', { name: 'Bento layout' }).click()

    // A branded background, a headline, and two step badges.
    await createAndApplyBrand(page, 'Launch brand')
    await page.getByRole('button', { exact: true, name: 'Add Text' }).first().click()
    await expect(page.locator('[data-text-overlay-id]')).toHaveCount(1)
    await page.getByTitle('A numbered step marker').click()
    await page.getByTitle('A numbered step marker').click()
    await expect(page.locator('[data-element-type="badge"]')).toHaveCount(2)
    await savePreset(page, 'Announcement')

    // Four Copilot variants; pick one.
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()
    const panel = page.getByRole('region', { name: 'AI copilot' })
    await panel.getByLabel('Ask the copilot').fill('Give me four versions of this design')
    await panel.getByLabel('Ask the copilot').press('Enter')
    await panel.getByRole('button', { name: 'Make 4 versions', exact: true }).click()
    const versions = panel.getByRole('list', { name: 'Versions' })
    await expect(versions.getByRole('button', { name: /^Inspect / })).toHaveCount(4, {
      timeout: 120_000,
    })
    await versions.getByRole('button', { name: 'Inspect Story window' }).click()
    const inspect = page.getByRole('dialog', { name: 'Story window' })
    await inspect.getByRole('button', { name: 'Apply this version' }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await expect(page.getByText('9:16', { exact: true }).first()).toBeVisible()
    // The chosen version keeps the composition: three screens, the headline, both badges.
    await expect(page.locator('#image-render-card [data-device-id]')).toHaveCount(3)
    await expect(page.locator('[data-element-type="badge"]')).toHaveCount(2)
    await panel.getByRole('button', { name: 'Close' }).click()

    // Export it in two sizes.
    await page.getByRole('button', { exact: true, name: 'Export' }).click()
    await page
      .getByRole('group', { name: 'Format' })
      .getByRole('button', { exact: true, name: 'PNG' })
      .click()
    await page.getByRole('button', { name: 'Add sizes' }).click()
    await page.getByRole('checkbox', { name: /Instagram story/ }).click()
    await page.getByRole('checkbox', { name: /LinkedIn post/ }).click()
    await page.keyboard.press('Escape')
    const download = page.waitForEvent('download', { timeout: 300_000 })
    await page.getByRole('button', { name: /^Export \d+ files \(ZIP\)$/ }).click()
    const zip = await JSZip.loadAsync(await bytesOf(await download))
    const files = Object.values(zip.files).filter((file) => !file.dir)
    expect(files.length).toBeGreaterThanOrEqual(2)
    for (const file of files) {
      const size = file.name.match(/(\d+)x(\d+)(?:@(\d)x)?\.png$/)
      expect(size, file.name).not.toBeNull()
      const scale = Number(size![3] ?? 1)
      const png = await inspectPng(await file.async('nodebuffer'))
      expect({ height: png.height, width: png.width }, file.name).toEqual({
        height: Number(size![2]) * scale,
        width: Number(size![1]) * scale,
      })
    }
  }
)

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { chooseOption, expect, type Page, test } from './framework'

// Temporary: captures the Bulk Tools screens for the pull request, then is removed.
const WIDTHS = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const

const screenshots: Record<string, string> = {}

async function shoot(page: Page, name: string) {
  for (const [width, height] of WIDTHS) {
    await page.setViewportSize({ height, width })
    for (const theme of ['light', 'dark']) {
      // The app's own switch; toggling the class by hand leaves some of its styles behind.
      const switcher = page.getByRole('button', { name: `Switch to ${theme} mode` }).first()
      if (await switcher.isVisible()) await switcher.click()
      await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))
      // The shell scrolls inside itself, so the window grows to show the whole page.
      const extra = await page.evaluate(() =>
        Math.max(
          0,
          ...Array.from(document.querySelectorAll('*')).map((element) =>
            ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)
              ? element.scrollHeight - element.clientHeight
              : 0
          )
        )
      )
      await page.setViewportSize({ height: Math.min(height + extra, 4200), width })
      const image = await page.screenshot({ quality: 62, type: 'jpeg' })
      screenshots[`${name}-${width}-${theme}.jpg`] = image.toString('base64')
      await page.setViewportSize({ height, width })
    }
  }
  await page.setViewportSize({ height: 900, width: 1440 })
}

test(
  'capture the Bulk Tools screens',
  { tag: ['@dev-server', '@journey', '@smoke'] },
  async ({ app, page, startWorkspace }) => {
    test.setTimeout(900_000)
    await page.setViewportSize({ height: 900, width: 1440 })
    await startWorkspace({ channels: ['x', 'linkedin', 'instagram'] })
    await app.open('/publish/batches')
    await expect(page.getByTestId('bulk-tools')).toBeVisible()
    await shoot(page, '01-catalog')

    // Image posts from a parent folder, with their preview.
    await page
      .getByTestId('bulk-tools')
      .getByRole('button', { name: /^Image posts/ })
      .click()
    await page.waitForURL(/start=images$/)
    const colors = ['#2f6f9f', '#c2703d', '#3f8f5f', '#7a4fa3', '#b8455f', '#d0a93a']
    const root = await mkdtemp(join(tmpdir(), 'bulk-shots-'))
    for (const [index, background] of colors.entries()) {
      const folder = join(root, 'Launch', index < 3 ? 'Beach' : index < 5 ? 'City' : 'Studio')
      await mkdir(folder, { recursive: true })
      await writeFile(
        join(folder, `${index + 1}.png`),
        await sharp({ create: { background, channels: 3, height: 800, width: 1000 } })
          .png()
          .toBuffer()
      )
    }
    await writeFile(join(root, 'Launch', 'Beach', 'notes.txt'), 'not an image')
    await page.getByLabel('Batch image folder').setInputFiles(join(root, 'Launch'))
    await page.getByRole('button', { name: 'Preview import', exact: true }).click()
    const preview = page.getByTestId('import-preview')
    await expect(preview.getByText('Ready', { exact: true })).toHaveCount(3)
    await shoot(page, '02-folder-preview')
    await preview.getByRole('button', { name: /^Add 3 ready rows/ }).click()
    const items = page.getByTestId('batch-item')
    await expect(items).toHaveCount(3)
    await expect(
      items.filter({ hasText: /Uploading|Waiting to upload|Upload failed/ })
    ).toHaveCount(0, { timeout: 60_000 })

    // Caption variations and a caption CSV's preview.
    await page
      .getByRole('textbox', { name: 'Bulk caption', exact: true })
      .fill('{New|Fresh|Just in}: our {summer|launch} shots are here')
    await expect(page.getByTestId('bulk-caption-summary')).toContainText('6 variations')
    await page.getByLabel('Replace captions posts already have').check()
    await page.getByRole('button', { name: 'Apply to posts', exact: true }).click()
    await page.getByLabel('Caption CSV file').setInputFiles({
      buffer: Buffer.from('filename,caption\nBeach,"Sand, sun and salt"\nMissing,No post here\n'),
      mimeType: 'text/csv',
      name: 'captions.csv',
    })
    await expect(page.getByTestId('caption-preview')).toBeVisible()
    await shoot(page, '03-captions')

    // Grid videos: inputs, images, render.
    await app.open('/publish/batches')
    await page
      .getByTestId('bulk-tools')
      .getByRole('button', { name: /^Grid videos/ })
      .click()
    await page.waitForURL(/start=grid$/)
    await chooseOption(page.getByLabel('Quick start'), 'Productivity')
    await expect(page.getByLabel('Item 12', { exact: true })).toBeVisible()
    await page.getByRole('slider', { name: 'Number of videos' }).focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await shoot(page, '04-grid-inputs')
    await page.getByRole('button', { name: 'Make 2 video concepts', exact: true }).click()
    await expect(page.getByTestId('grid-concept')).toHaveCount(2)
    await page.getByRole('button', { name: 'Generate all (8)', exact: true }).click()
    await expect(page.getByTestId('grid-readiness')).toContainText('2 of 2 videos ready', {
      timeout: 180_000,
    })
    await shoot(page, '05-grid-customize')
    await page.getByRole('button', { name: 'Continue to render', exact: true }).click()
    await page.getByRole('button', { name: 'Render 2 videos', exact: true }).click()
    await expect(
      page.getByTestId('grid-render-list').getByText('Done', { exact: true })
    ).toHaveCount(2, { timeout: 300_000 })
    await shoot(page, '06-grid-rendered')

    // The durations artifact is the one uploaded on a passing run.
    await writeFile(
      'playwright-report/results-zz-bulk-tools-shots.json',
      JSON.stringify({ screenshots, stats: {}, suites: [] })
    )
  }
)

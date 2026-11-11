import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { CANVAS_RECIPES, buildRecipe, canvasRecipeSchema } from '@/lib/canvas/recipes'
import type { CanvasDocument } from '@/lib/canvas/document'
import { documentCanvasSize } from '@/lib/export/adapt'
import { expect, test, trpcQuery } from './framework'

test.use({ thirdPartyAssets: true, workspaceOptions: { plan: 'pro' } })

const output = path.resolve('.context/template-previews')
const fill = () => 'data:image/png;base64,cGxhY2Vob2xkZXI='

for (const width of [1440, 390]) {
  test(
    `all template previews render at ${width}px without shifting cards`,
    { tag: '@journey' },
    async ({ app, page }) => {
      await page.setViewportSize({ width, height: 1000 })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text())
      })
      await app.open('/canvas/new?start=template')
      const gallery = page.getByRole('region', { name: 'Starting point', exact: true })
      await expect(gallery.locator('[data-recipe-preview]')).toHaveCount(8)
      // The final section must not render until it approaches the viewport.
      await expect(gallery.locator('[data-recipe-preview="social-pack"] img')).toHaveCount(0)

      for (const recipe of canvasRecipeSchema.options) {
        const card = gallery.getByRole('button', { name: CANVAS_RECIPES[recipe].name, exact: true })
        const preview = card.locator('[data-recipe-preview]')
        await expect(preview).toHaveAttribute('aria-hidden', 'true')
        await card.scrollIntoViewIfNeeded()
        const before = await card.boundingBox()
        const artboards = buildRecipe(recipe, {}, { fill })
        const images = preview.locator('img')
        await expect(images).toHaveCount(artboards.length, { timeout: 120_000 })
        for (const [index, artboard] of artboards.entries()) {
          const image = images.nth(index)
          await expect(image).toHaveAttribute('alt', '')
          await expect
            .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
            .toBeGreaterThan(0)
          const aspect = await image.evaluate(
            (node: HTMLImageElement) => node.naturalWidth / node.naturalHeight
          )
          const size = documentCanvasSize(artboard.document)
          expect(aspect).toBeCloseTo(size.width / size.height, 2)
        }
        const after = await card.boundingBox()
        expect(after?.height).toBe(before?.height)
        expect(after?.width).toBe(before?.width)
        await expect(card).toContainText(CANVAS_RECIPES[recipe].description)
        await expect(card).toContainText(CANVAS_RECIPES[recipe].artboards)
      }
      const feature = gallery.getByRole('button', { name: 'Feature announcement', exact: true })
      const release = gallery.getByRole('button', { name: 'Release announcement', exact: true })
      const featureBox = (await feature.boundingBox())!
      const releaseBox = (await release.boundingBox())!
      if (width > 640) {
        expect(featureBox.y).toBe(releaseBox.y)
        expect(featureBox.height).toBe(releaseBox.height)
      } else {
        expect(featureBox.x).toBe(releaseBox.x)
        expect(releaseBox.y).toBeGreaterThan(featureBox.y)
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true)

      // Selecting with the keyboard, then returning, reuses the rendered sample.
      const firstURL = await feature.locator('img').getAttribute('src')
      await feature.focus()
      await expect(feature).toBeFocused()
      expect(await feature.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe('none')
      await page.keyboard.press('Enter')
      await expect(
        page.getByRole('heading', { name: 'Feature announcement', exact: true })
      ).toBeVisible()
      await page.getByRole('button', { name: '← All templates' }).click()
      await expect(feature.locator('img')).toHaveAttribute('src', firstURL!)
      for (const preview of await gallery.locator('[data-recipe-preview]').all()) {
        await preview.scrollIntoViewIfNeeded()
        await expect(preview.locator('img').first()).toBeVisible()
      }
      await page.evaluate(() => window.scrollTo(0, 0))
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: path.join(output, `after-${width}.png`), fullPage: true })

      // The way to start can be changed again, and keyboard focus follows each switch.
      const back = page.getByRole('button', { name: '← All ways to start', exact: true })
      await back.click()
      await expect(gallery).toHaveCount(0)
      const template = page
        .getByRole('navigation', { name: 'Ways to start', exact: true })
        .getByRole('button', { name: /^Start from a template/ })
      await expect(template).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(gallery).toBeVisible()
      await expect(back).toBeFocused()
      expect(errors).toEqual([])
    }
  )
}

test(
  'preview selection preserves the four main template creation flows',
  { tag: '@journey' },
  async ({ app, page }) => {
    for (const recipe of [
      'feature-announcement',
      'product-launch',
      'walkthrough',
      'social-pack',
    ] as const) {
      await app.open('/canvas/new?start=template')
      await page.getByRole('button', { name: CANVAS_RECIPES[recipe].name, exact: true }).click()
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(page).toHaveURL(/\/canvas\/c[a-z0-9]{24}$/, { timeout: 120_000 })
      await expect(page.getByTestId('canvas-workspace')).toBeVisible()
      const canvasId = new URL(page.url()).pathname.split('/').pop()!
      const stored = await trpcQuery(page, 'canvas.get', { canvasId })
      expect(stored.status).toBe(200)
      const actual = (stored.body as { document: CanvasDocument }).document.artboards
      const expected = buildRecipe(recipe, {}, { fill })
      // Generated ids and browser-encoded fill pixels vary; all authored content must match.
      const content = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value, (key, item) =>
            key === 'id' || key === 'layerId' || key === 'src' ? undefined : item
          )
        )
      expect(content(actual)).toEqual(content(expected))
      expect(actual.map((artboard) => artboard.document.image.src)).toEqual(
        expected.map((artboard) => artboard.document.image.src)
      )
    }
  }
)

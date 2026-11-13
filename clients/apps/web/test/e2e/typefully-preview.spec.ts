import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import {
  addBatchRows,
  apiRequest,
  chooseOption,
  draftEditor,
  editorMore,
  expect,
  expectSaved,
  openNewBatch,
  openNewDraft,
  saveBatchDrafts,
  signedAssetSchema,
  test,
  uploadSignedAsset,
} from './framework'
import { importedBody } from '@/lib/write/import-text'

test.use({ actionTimeout: 30_000 })
const fixture = (name: string) => `test/fixtures/typefully-media/${name}`
test(
  'phone previews fit the sidebar, weighted long text expands, and link cards offer only real controls',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const url = `https://example.com/${'path'.repeat(100)}`
    const text = 'a'.repeat(250) + ' ' + url
    await page.route('**/api/v1/content-drafts/link-card?*', (route) =>
      route.fulfill({
        json: {
          url,
          title: 'Linked resource',
          description: 'Fetched metadata',
          image: null,
          siteName: 'Example',
        },
      })
    )
    const id = await openNewDraft(page)
    await draftEditor(page).fill(text)
    await expectSaved(page)
    // X makes the card itself and its API cannot remove it, so no removal control is offered.
    const links = page.getByRole('region', { name: 'Link previews' })
    await expect(links).toContainText('X makes this card from the link itself')
    await expect(links.getByRole('button', { name: 'Remove preview' })).toHaveCount(0)
    // LinkedIn makes no card from the text and Shots sends none.
    await page.getByTestId('platform-tab-linkedin').click()
    await expect(page.getByTestId('plain-links')).toBeVisible()
    await page.getByTestId('platform-tab-x').click()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = page.getByTestId('preview-x')
    await expect(preview.getByRole('button', { name: 'Show more', exact: true })).toHaveCount(0)
    await expect(preview.getByTestId('post-link-preview')).toContainText('Linked resource')
    await expect(preview.getByRole('button', { name: 'Hide link preview' })).toHaveCount(0)
    // Preview takes the draft's place, so editing means going back to it; the URL stayed in the text.
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(draftEditor(page)).toContainText(url)
    await draftEditor(page).fill(text + ' 👩🏽‍💻'.repeat(10) + ' ending')
    await expectSaved(page)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(preview.getByRole('button', { name: 'Show more', exact: true })).toBeVisible()
    await expect(preview).not.toContainText('ending')
    await preview.getByRole('button', { name: 'Show more', exact: true }).click()
    await expect(preview).toContainText('ending')
    await chooseOption(page.getByLabel('Preview device'), /^iPhone 17 Pro Max/)
    await expect(page.getByTestId('preview-device-content')).toHaveCSS('width', '440px')
    await expect
      .poll(async () => {
        const box = await preview.boundingBox(),
          parent = await page.getByTestId('preview-scroll').boundingBox()
        return !!box && !!parent && box.width <= parent.width + 1 && box.x >= parent.x - 1
      })
      .toBe(true)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect
      .poll(async () => {
        const box = await preview.boundingBox()
        return !!box && box.x >= -1 && box.x + box.width <= 391
      })
      .toBe(true)
    await app.reload()
    await expect(draftEditor(page)).toContainText('ending')
    const saved = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      plainText: string
    }
    expect(saved.plainText).toContain(url)
    expect(errors).toEqual([])
  }
)

test(
  'uploaded video plays in preview and imported PDFs render both carousel pages after reload',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    await addBatchRows(
      page,
      'caption,asset,channels\nMoving picture,preview.mp4,x\nTwo-page document,preview.pdf,linkedin',
      [fixture('preview.mp4'), fixture('preview.pdf')]
    )
    const [videoURL, pdfURL] = (await saveBatchDrafts(page)).map((id) => `/publish/${id}`)
    await page.goto(videoURL)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const video = page.getByTestId('preview-x').getByLabel('Attached video')
    await expect(video).toBeVisible()
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThan(0)
    expect(await video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(64)
    await video.evaluate((el: HTMLVideoElement) => el.play())
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeGreaterThan(0)
    await app.reload()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(video).toBeVisible()
    await page.goto(pdfURL)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const carousel = page.getByTestId('pdf-carousel')
    await expect(carousel.getByTestId('pdf-page-count')).toHaveText('2 pages', {
      timeout: 45_000,
    })
    await expect
      .poll(() =>
        carousel
          .locator('canvas')
          .evaluate(
            (el: HTMLCanvasElement) => el.getContext('2d')!.getImageData(20, 20, 1, 1).data[2]
          )
      )
      .toBe(255)
    await carousel.getByRole('button', { name: 'Next →', exact: true }).click()
    await expect(
      carousel.getByRole('img', {
        name: 'Document preview, page 2. Use the original PDF for selectable text.',
        exact: true,
      })
    ).toBeVisible()
    await expect
      .poll(() =>
        carousel
          .locator('canvas')
          .evaluate(
            (el: HTMLCanvasElement) => el.getContext('2d')!.getImageData(20, 20, 1, 1).data[0]
          )
      )
      .toBe(255)
    await app.reload()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(carousel.getByTestId('pdf-page-count')).toHaveText('2 pages')
    expect(errors).toEqual([])
  }
)

test(
  'link images and searched GIFs become real workspace assets; article covers preview their stored bytes',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    test.skip(
      !process.env.NEXT_PUBLIC_PLATFORM_GIPHY_API_KEY,
      'Requires a configured fixture or production GIPHY key.'
    )
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const workspace = await startWorkspace({ channels: ['x'] })
    const image = await sharp({
      create: { width: 1200, height: 630, channels: 3, background: '#6611bb' },
    })
      .jpeg()
      .toBuffer()
    const gif = await readFile(fixture('preview.gif'))
    await page.route('**/api/v1/content-drafts/link-card?*', (route) =>
      route.fulfill({
        json: {
          url: 'https://example.com/article',
          title: 'Article image',
          description: null,
          image: 'https://example.com/cover.jpg',
          siteName: 'Example',
        },
      })
    )
    await page.route('**/api/link-preview/image?*', (route) =>
      route.fulfill({ contentType: 'image/jpeg', body: image })
    )
    const sha256 = createHash('sha256').update(gif).digest('hex')
    const signed = await apiRequest(page, '/api/tenant/assets/upload-url', {
      method: 'POST',
      body: {
        bytes: gif.length,
        classification: 'input',
        contentType: 'image/gif',
        fileName: 'fixture.gif',
        sha256,
      },
    })
    expect(signed.status).toBe(201)
    const stored = signedAssetSchema.parse(signed.body)
    expect(await uploadSignedAsset(page, stored.uploadUrl, [...gif], 'image/gif')).toBe(200)
    expect(
      (
        await apiRequest(page, `/api/tenant/assets/${stored.asset.id}/complete`, {
          method: 'POST',
          body: { sha256 },
        })
      ).status
    ).toBe(200)
    await page.route('**/api/v1/content-drafts/giphy*', (route) =>
      route.fulfill({
        json:
          route.request().method() === 'POST'
            ? { assetId: stored.asset.id, sourceUrl: 'https://giphy.com/gifs/fixture' }
            : {
                items: [
                  {
                    id: 'fixture',
                    title: 'Moving colors',
                    previewUrl: '/api/v1/assets/' + stored.asset.id + '/content',
                    sourceUrl: 'https://giphy.com/gifs/fixture',
                  },
                ],
              },
      })
    )
    const id = await openNewDraft(page)
    await draftEditor(page).fill('Media sources')
    await expectSaved(page)
    await editorMore(page, 'Image from link')
    await page.getByLabel('Page URL', { exact: true }).fill('https://example.com/article')
    await page.getByRole('button', { name: 'Find image', exact: true }).click()
    await page.getByRole('button', { name: 'Attach image', exact: true }).click()
    await expect(page.getByTestId('media-strip-item')).toHaveCount(1)
    await editorMore(page, 'GIF')
    await page.getByLabel('Search GIFs').fill('colors')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('button', { name: 'Attach Moving colors', exact: true }).click()
    await expect(page.getByTestId('media-strip-item')).toHaveCount(2)
    await expectSaved(page)
    await app.reload()
    const draft = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      assetIds: string[]
    }
    expect(draft.assetIds).toHaveLength(2)
    const metadata = []
    for (const asset of draft.assetIds) {
      const result = await page.request.get(`/api/v1/assets/${asset}/content`)
      expect(result.status()).toBe(200)
      metadata.push(await sharp(await result.body(), { animated: true }).metadata())
    }
    expect(metadata[0].width).toBe(1200)
    expect(metadata[1].format).toBe('gif')
    expect(metadata[1].pages).toBe(2)
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        kind: 'article',
        article: { title: 'An article worth reading', coverAssetId: draft.assetIds[0] },
        body: importedBody(['Article content']),
        plainText: 'Article content',
        assetIds: [draft.assetIds[0]],
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await app.open(`/publish/${(created.body as { id: string }).id}`)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = page.getByTestId('preview-x')
    await expect(
      preview.getByRole('heading', { name: 'An article worth reading', exact: true })
    ).toBeVisible()
    await expect
      .poll(() =>
        preview
          .getByAltText('Article cover', { exact: true })
          .evaluate((el: HTMLImageElement) => el.naturalWidth)
      )
      .toBe(1200)
    expect(errors).toEqual([])
  }
)

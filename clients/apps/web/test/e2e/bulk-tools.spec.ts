import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  apiRequest,
  chooseOption,
  expect,
  openNewBatch,
  type Page,
  readMp4Tracks,
  saveBatchDrafts,
  test,
} from './framework'

test.use({ actionTimeout: 30_000 })

const png = () =>
  sharp({ create: { width: 320, height: 240, channels: 3, background: '#e5eef8' } })
    .png()
    .toBuffer()

/** A real folder on disk: a directory input reads paths from it. */
async function writeFolder(files: Record<string, Buffer | string>) {
  const root = await mkdtemp(join(tmpdir(), 'bulk-tools-'))
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), body)
  }
  return root
}

const captionFile = (body: string) => ({
  buffer: Buffer.from(body),
  mimeType: 'text/csv',
  name: 'captions.csv',
})

const captions = (page: Page) =>
  page
    .getByTestId('batch-item')
    .getByRole('textbox', { name: /^Caption for item/ })
    .evaluateAll((boxes) => boxes.map((box) => (box as HTMLTextAreaElement).value))

test(
  'a parent folder becomes posts, captions apply in bulk, and all of it survives a reload',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    const image = await png()
    // The same file name in two folders must stay two files.
    const root = await writeFolder({
      'Trip/Beach/1.png': image,
      'Trip/Beach/2.png': image,
      'Trip/City/1.png': image,
      'Trip/City/.DS_Store': 'hidden',
      'Trip/City/notes.txt': 'not an image',
    })
    try {
      await page.getByLabel('Batch image folder').setInputFiles(join(root, 'Trip'))
      await page.getByRole('button', { name: 'Preview import', exact: true }).click()
      const preview = page.getByTestId('import-preview')
      await expect(preview.getByText('Ready', { exact: true })).toHaveCount(2)
      await expect(page.getByTestId('import-skipped')).toContainText('.DS_Store')
      await expect(page.getByTestId('import-skipped')).toContainText('notes.txt')
      // Nothing is added until the preview is accepted.
      expect(await page.getByTestId('batch-item').count()).toBe(0)
      await preview.getByRole('button', { name: /^Add 2 ready rows/ }).click()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
    const items = page.getByTestId('batch-item')
    await expect(items).toHaveCount(2)
    await expect(
      items.filter({ hasText: /Uploading|Waiting to upload|Upload failed/ })
    ).toHaveCount(0, { timeout: 60_000 })
    await expect(items.first().getByRole('listitem')).toHaveCount(2)
    await expect(items.last().getByRole('listitem')).toHaveCount(1)

    // A caption CSV matches folder names, and shows what it cannot match before applying.
    await page
      .getByLabel('Caption CSV file')
      .setInputFiles(
        captionFile(
          'filename,caption\nbeach,"Sand, sun and salt"\nCITY,Streets at night\nMissing,No post\n'
        )
      )
    const matched = page.getByTestId('caption-preview')
    await expect(matched.getByText('Matched', { exact: true })).toHaveCount(2)
    await expect(matched.getByText('Line 4: no post is named Missing.')).toBeVisible()
    await matched.getByRole('button', { name: 'Apply 2 captions', exact: true }).click()
    await expect.poll(() => captions(page)).toEqual(['Sand, sun and salt', 'Streets at night'])

    // Variations say what they will do; without "replace", captions stay.
    const source = page.getByRole('textbox', { name: 'Bulk caption', exact: true })
    await source.fill('{Alpha|Beta|Gamma} technical test {one|two}')
    await expect(page.getByTestId('bulk-caption-summary')).toContainText('6 variations')
    await expect(page.getByTestId('bulk-caption-summary')).toContainText('longest 24 of 280')
    await page.getByRole('button', { name: 'Apply to posts', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'already has a caption' })).toBeVisible()
    await page.getByLabel('Replace captions posts already have').check()

    // Too long for one chosen account: refused, naming it, and nothing changes.
    await source.fill(`{Short|${'a'.repeat(281)}}`)
    await page.getByRole('button', { name: 'Apply to posts', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: '281 characters' })).toBeVisible()
    expect(await captions(page)).toEqual(['Sand, sun and salt', 'Streets at night'])

    await source.fill('{Alpha|Beta|Gamma} technical test {one|two}')
    await page.getByRole('button', { name: 'Apply to posts', exact: true }).click()
    const pattern = /^(Alpha|Beta|Gamma) technical test (one|two)$/
    await expect
      .poll(async () => (await captions(page)).every((text) => pattern.test(text)))
      .toBe(true)

    // What was applied is stored as it is: a reload shows the same captions, not new rolls.
    const applied = await captions(page)
    await app.reload()
    await expect(page.getByTestId('batch-item')).toHaveCount(2)
    expect(await captions(page)).toEqual(applied)

    // Spread carries a day's posts past midnight, and the page counts the real days.
    const id = new URL(page.url()).pathname.split('/').pop()!
    const batch = (await apiRequest(page, `/api/v1/content-batches/${id}`)).body as {
      items: { id: string }[]
      socialSetId: string
      timeZone: string
    }
    const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const times = await apiRequest(page, '/api/v1/content-draft-batch/times', {
      body: {
        count: 5,
        localTime: `${day}T08:00`,
        mode: 'spread',
        postsPerDay: 4,
        seed: 'bulk-tools-e2e-seed',
        socialSetId: batch.socialSetId,
        spacingMinutes: 360,
      },
      method: 'POST',
    })
    expect(times.status).toBe(200)
    const instants = (times.body as { times: string[] }).times.map((at) => Date.parse(at))
    expect(instants.slice(1).map((at, index) => (at - instants[index]!) / 3_600_000)).toEqual([
      6, 6, 6, 6,
    ])
    const moved = await apiRequest(page, `/api/v1/content-batches/${id}/items`, {
      body: {
        items: [
          {
            itemId: batch.items[0]!.id,
            timing: { localTime: `${day}T20:00`, mode: 'time', timeZone: batch.timeZone },
          },
          {
            itemId: batch.items[1]!.id,
            timing: { localTime: `${day}T23:30`, mode: 'time', timeZone: batch.timeZone },
          },
        ],
      },
      method: 'PATCH',
    })
    expect(moved.status).toBe(200)
    await app.reload()
    await expect(page.getByTestId('batch-summary')).toContainText('on 1 calendar day')
    await expect(page.getByTestId('batch-summary')).toContainText('2 posts to 4 destinations')

    // One refused row refuses the whole bulk change.
    const refused = await apiRequest(page, `/api/v1/content-batches/${id}/items`, {
      body: {
        items: [
          { caption: 'Changed', itemId: batch.items[0]!.id },
          { caption: 'Twice', itemId: batch.items[0]!.id },
        ],
      },
      method: 'PATCH',
    })
    expect(refused.status).toBe(400)
    await app.reload()
    expect(await captions(page)).toEqual(applied)

    // They become ordinary drafts, with their files in name order.
    const drafts = await saveBatchDrafts(page)
    expect(drafts).toHaveLength(2)
    const first = (await apiRequest(page, `/api/v1/content-drafts/${drafts[0]}`)).body as {
      assetIds: string[]
    }
    expect(first.assetIds).toHaveLength(2)
  }
)

test(
  'grid videos go from captions to an MP4 that schedules like any post',
  // The scripted image model only runs under next dev.
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page, startWorkspace }) => {
    test.setTimeout(600_000)
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await app.open('/publish/batches')
    await page
      .getByTestId('bulk-tools')
      .getByRole('button', { name: /^Grid videos/ })
      .click()
    await page.waitForURL(/\/publish\/batches\/[^/?]+\?start=grid$/)
    await expect(page.getByRole('heading', { name: 'Grid videos', exact: true })).toBeVisible()

    // Input is checked in order, and a preset fills it.
    await page.getByRole('button', { name: 'Make 5 video concepts', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: 'at least one caption' })).toBeVisible()
    await page.getByLabel('Caption 1', { exact: true }).fill('Four tools I use')
    await page.getByRole('button', { name: 'Make 5 video concepts', exact: true }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'at least one content item' })
    ).toBeVisible()
    await chooseOption(page.getByLabel('Quick start'), 'Productivity')
    await expect(page.getByLabel('Item 12', { exact: true })).toBeVisible()
    await page.getByRole('slider', { name: 'Number of videos' }).focus()
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.getByRole('button', { name: 'Make 2 video concepts', exact: true }).click()

    const concepts = page.getByTestId('grid-concept')
    await expect(concepts).toHaveCount(2)
    await expect(page.getByTestId('grid-readiness')).toContainText('0 of 2 videos ready')
    await expect(page.getByTestId('grid-readiness')).toContainText('8 images missing')
    await expect(page.getByText(/about 32 AI credits/)).toBeVisible()

    // A concept is durable: a fresh load comes back to it.
    await app.reload()
    await expect(concepts).toHaveCount(2)

    // Unrendered concepts cannot become drafts.
    await expect(
      page.getByRole('button', { name: 'Save ready items as drafts', exact: true })
    ).toBeDisabled()

    // One video gets a new caption; another is redrawn, keeping its music and place.
    await page.getByRole('button', { name: 'New caption for video 1', exact: true }).click()
    await expect(page.getByLabel('Headline for video 1')).toHaveValue('Scripted suggestion one')
    const topics = () =>
      Promise.all(
        [1, 2, 3, 4].map((slot) => page.getByLabel(`Label for video 2 image ${slot}`).inputValue())
      )
    const before = await topics()
    await page.getByRole('button', { name: 'Generate video 2 image 1', exact: true }).click()
    await expect(page.getByTestId('grid-readiness')).toContainText('7 images missing', {
      timeout: 60_000,
    })
    page.once('dialog', (dialog) => void dialog.accept())
    await page.getByRole('button', { name: 'Regenerate video 2', exact: true }).click()
    await expect(page.getByTestId('grid-readiness')).toContainText('8 images missing')
    await expect.poll(async () => (await topics()).join()).not.toBe(before.join())

    // The last cell setting writes the bottom right of every video.
    await page.getByLabel('Last cell label').fill('Follow for more')
    await page.getByRole('button', { name: 'Apply to all videos', exact: true }).click()
    await expect(page.getByLabel('Label for video 1 image 4')).toHaveValue('Follow for more')
    await expect(page.getByLabel('Label for video 2 image 4')).toHaveValue('Follow for more')

    // Your own music, then images for every slot.
    await page.getByLabel('Music for all videos').setInputFiles('test/e2e/fixtures/tone.wav')
    await expect(page.getByRole('button', { name: 'Remove music', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Generate all (8)', exact: true }).click()
    await expect(page.getByTestId('grid-readiness')).toContainText('2 of 2 videos ready', {
      timeout: 120_000,
    })

    await page.getByRole('button', { name: 'Continue to render', exact: true }).click()
    await page.getByRole('button', { name: 'Render 2 videos', exact: true }).click()
    const list = page.getByTestId('grid-render-list')
    await expect(list.getByText('Done', { exact: true })).toHaveCount(2, { timeout: 300_000 })

    // The server recorded the run: what was frozen, and each video it made.

    // The saved video is what the analysis measured: 9:16, 6 seconds, H.264 and AAC.
    const id = new URL(page.url()).pathname.split('/').pop()!
    const batch = (await apiRequest(page, `/api/v1/content-batches/${id}`)).body as {
      items: {
        media: { assetId: string; durationMs: number; height: number; width: number }[]
      }[]
      render: { id: string; items: { assetId: string; status: string }[]; status: string }
    }
    expect(batch.render.status).toBe('FINISHED')
    expect(batch.render.items.map((item) => item.status)).toEqual(['DONE', 'DONE'])
    const media = batch.items[0]!.media[0]!
    expect(batch.render.items[0]!.assetId).toBe(media.assetId)
    // Only what the run froze can be recorded.
    const stale = await apiRequest(
      page,
      `/api/v1/content-batches/${id}/renders/${batch.render.id}/items/cmissingitem00000000000000`,
      { body: { error: 'Not in this run.' }, method: 'POST' }
    )
    expect(stale.status).toBe(404)
    expect([media.width, media.height]).toEqual([1080, 1920])
    expect(media.durationMs).toBeGreaterThanOrEqual(5900)
    expect(media.durationMs).toBeLessThanOrEqual(6100)
    const file = await page.evaluate(async (assetId) => {
      const response = await fetch(`/api/v1/assets/${assetId}/content`)
      return [...new Uint8Array(await response.arrayBuffer())]
    }, media.assetId)
    const tracks = readMp4Tracks(Buffer.from(file))
    expect(tracks.map((track) => track.codec).sort()).toEqual(['avc1', 'mp4a'])

    // Downloading several gives one archive.
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download all (2)', exact: true }).click()
    expect((await download).suggestedFilename()).toBe('grid-videos.zip')

    // From here it is an ordinary post of the batch.
    const drafts = await saveBatchDrafts(page)
    expect(drafts).toHaveLength(2)
    const draft = (await apiRequest(page, `/api/v1/content-drafts/${drafts[0]}`)).body as {
      assetIds: string[]
      plainText: string
    }
    expect(draft.assetIds).toEqual([media.assetId])
    expect(draft.plainText.length).toBeGreaterThan(0)
  }
)

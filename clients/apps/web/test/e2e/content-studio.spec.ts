import sharp from 'sharp'
import {
  apiRequest,
  type App,
  decodeMp4,
  expect,
  type Page,
  readMp4Tracks,
  saveBatchDrafts,
  test,
} from './framework'

// Content Studio templates (docs/scheduling/post-bridge/content-studio/implementation.md):
// fade-in and UGC videos are batch items rendered in the browser, like grid videos.

test.use({ actionTimeout: 30_000 })

const png = (background: string) =>
  sharp({ create: { width: 500, height: 400, channels: 3, background } })
    .png()
    .toBuffer()

/** Start a batch of one kind of template video from Bulk tools. */
async function startStudioBatch(page: Page, app: App, label: string, start: string) {
  await app.open('/publish/batches')
  await page
    .getByTestId('bulk-tools')
    .getByRole('radio', { name: new RegExp(`^${label}`) })
    .click()
  await page.getByRole('button', { name: 'Start a batch', exact: true }).click()
  await page.waitForURL(new RegExp(`/publish/batches/[^/?]+\\?start=${start}$`))
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
}

type SavedBatch = {
  items: { media: { assetId: string; durationMs: number; height: number; width: number }[] }[]
  render: { items: { assetId?: string; status: string }[]; status: string }
}

/** The batch as the server holds it. */
async function readBatch(page: Page) {
  const id = new URL(page.url()).pathname.split('/').pop()!
  return (await apiRequest(page, `/api/v1/content-batches/${id}`)).body as SavedBatch
}

/** A stored asset's bytes, read as the signed-in person. */
async function assetBytes(page: Page, assetId: string) {
  const bytes = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/assets/${id}/content`)
    return [...new Uint8Array(await response.arrayBuffer())]
  }, assetId)
  return Buffer.from(bytes)
}

test(
  'fade-in videos render with trimmed music or image only, survive a reload and become drafts',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    test.setTimeout(600_000)
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await startStudioBatch(page, app, 'Fade-in videos', 'single')

    // One video with a headline, one image only.
    const concepts = page.getByTestId('template-concept')
    await page.getByLabel('Headline for the new video', { exact: true }).fill('One image, one idea')
    await page.getByRole('button', { name: 'Add video', exact: true }).click()
    await expect(concepts).toHaveCount(1)
    await page.getByRole('switch', { name: 'No caption (image only) for the new video' }).click()
    await expect(page.getByLabel('Headline for the new video', { exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Add video', exact: true }).click()
    await expect(concepts).toHaveCount(2)
    await expect(page.getByLabel('Headline for video 2', { exact: true })).toBeDisabled()

    // Image only disables the headline but keeps it (ST-009).
    const headline = page.getByLabel('Headline for video 1', { exact: true })
    const imageOnly = page.getByRole('switch', { name: 'No caption (image only) for video 1' })
    await imageOnly.click()
    await expect(headline).toBeDisabled()
    await expect(headline).toHaveValue('One image, one idea')
    await imageOnly.click()
    await expect(headline).toBeEnabled()
    await expect(headline).toHaveValue('One image, one idea')

    // Without an image a video cannot render.
    await expect(concepts.nth(0).getByText('Needs an image', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Render \d video/ })).toHaveCount(0)
    await page
      .getByLabel('Image for video 1', { exact: true })
      .setInputFiles({ buffer: await png('#f4c95d'), mimeType: 'image/png', name: 'one.png' })
    await page
      .getByLabel('Image for video 2', { exact: true })
      .setInputFiles({ buffer: await png('#5d9cf4'), mimeType: 'image/png', name: 'two.png' })
    await expect(concepts.getByText('Ready to render', { exact: true })).toHaveCount(2)

    // Music the browser cannot decode is refused before it uploads (ST-043).
    await page.getByLabel('Music for video 1', { exact: true }).setInputFiles({
      buffer: Buffer.from('not audio at all'),
      mimeType: 'audio/mpeg',
      name: 'broken.mp3',
    })
    await expect(concepts.nth(0).getByRole('alert')).toContainText('cannot decode')

    // A track shorter than the video plays once from its start: there is nothing to trim.
    await page
      .getByLabel('Music for video 2', { exact: true })
      .setInputFiles('test/e2e/fixtures/tone.wav')
    await page.getByRole('button', { name: 'Trim music for video 2', exact: true }).click()
    await expect(page.getByTestId('trim-excerpt')).toContainText(
      'plays once from its start, then the video is silent'
    )
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Remove music', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Trim music for video 2' })).toHaveCount(0)

    // A longer track trims to where the video starts it. Cancel drops the change (ST-016),
    // and the help names the chosen interval (ST-018).
    await page
      .getByLabel('Music for video 1', { exact: true })
      .setInputFiles('test/e2e/fixtures/music-10s.mp3')
    const trim = page.getByRole('button', { name: 'Trim music for video 1', exact: true })
    const excerpt = page.getByTestId('trim-excerpt')
    const slider = page.getByRole('slider', { name: 'Music start' })
    await trim.click()
    await expect(excerpt).toHaveText(/^Plays 0:00\.0 to 0:06\.0 of the 0:10\.\d track\.$/)
    await slider.focus()
    await page.keyboard.press('End')
    await expect(excerpt).toHaveText(/^Plays 0:04\.0 to 0:10\.0 of the 0:10\.\d track\.$/)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await trim.click()
    await expect(excerpt).toHaveText(/^Plays 0:00\.0 to 0:06\.0/)
    await slider.focus()
    await page.keyboard.press('End')
    await page.getByRole('button', { name: 'Save selection', exact: true }).click()
    await expect(trim).toHaveText('Trim (from 0:04.0)')

    // Everything above is on the server: a fresh load comes back to it.
    await app.reload()
    await expect(concepts).toHaveCount(2)
    await expect(trim).toHaveText('Trim (from 0:04.0)')
    await expect(page.getByLabel('Headline for video 2', { exact: true })).toBeDisabled()
    await expect(page.getByRole('img', { name: 'Preview of video 1', exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Render 2 videos', exact: true }).click()
    await expect(concepts.getByText('Done', { exact: true })).toHaveCount(2, { timeout: 300_000 })
    // A finished render survives a reload.
    await app.reload()
    await expect(concepts.getByText('Done', { exact: true })).toHaveCount(2)

    const batch = await readBatch(page)
    expect(batch.render.status).toBe('FINISHED')
    const [withMusic, silent] = batch.items.map((item) => item.media[0]!)
    for (const media of [withMusic!, silent!]) {
      expect([media.width, media.height]).toEqual([1080, 1920])
      expect(media.durationMs).toBeGreaterThanOrEqual(5900)
      expect(media.durationMs).toBeLessThanOrEqual(6100)
    }
    // AAC only where there is music (ST-042); 180 frames, fading in from dark.
    const musical = await assetBytes(page, withMusic!.assetId)
    const musicalTracks = readMp4Tracks(musical)
    expect(musicalTracks.map((track) => track.codec).sort()).toEqual(['avc1', 'mp4a'])
    const decoded = await decodeMp4(
      page,
      musical,
      musicalTracks.find((track) => track.handler === 'vide')!
    )
    expect(decoded.decodedFrames).toBe(180)
    expect(decoded.firstToMiddle).toBeGreaterThan(20)
    expect(decoded.during).toBeGreaterThan(0.01)
    const quiet = readMp4Tracks(await assetBytes(page, silent!.assetId))
    expect(quiet.map((track) => track.codec)).toEqual(['avc1'])
    expect(quiet[0]!.samples).toHaveLength(180)

    // The composer gets the video by its asset ID, as an ordinary post of the batch.
    const drafts = await saveBatchDrafts(page)
    expect(drafts).toHaveLength(2)
    const draft = (await apiRequest(page, `/api/v1/content-drafts/${drafts[0]}`)).body as {
      assetIds: string[]
    }
    expect(draft.assetIds).toEqual([withMusic!.assetId])
  }
)

test(
  'a UGC video takes a clip, text ideas and a closing clip, renders, and becomes a draft',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    test.setTimeout(600_000)
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await startStudioBatch(page, app, 'UGC videos', 'ugc')

    const concepts = page.getByTestId('template-concept')
    const addVideo = page.getByRole('button', { name: 'Add video', exact: true })
    await expect(addVideo).toBeDisabled()
    await page
      .getByLabel('Text for the new video', { exact: true })
      .fill('POV: you finally\nfound it')
    await addVideo.click()
    await expect(concepts).toHaveCount(1)
    const text = page.getByRole('textbox', { name: 'Text for video 1', exact: true })
    await expect(text).toHaveValue('POV: you finally\nfound it')

    // Text position is a named choice.
    const bottom = page
      .getByRole('group', { name: 'Text position for video 1' })
      .getByRole('button', { name: 'Bottom', exact: true })
    await bottom.click()
    await expect(bottom).toHaveAttribute('aria-pressed', 'true')

    // The caption assistant (ST-045): a failure keeps the description to try again.
    const ideas = /\/api\/trpc\/[^?]*editorAi\.suggestOverlayIdeas/
    let failNext = true
    await page.route(ideas, async (route) => {
      if (failNext) {
        failNext = false
        await route.abort('failed')
        return
      }
      await route.continue()
    })
    await page.getByRole('button', { name: 'Write text for video 1 with AI', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const generate = dialog.getByRole('button', { name: 'Generate', exact: true })
    await expect(generate).toBeDisabled()
    await dialog
      .getByLabel('Product or topic', { exact: true })
      .fill('A paper planner for busy parents')
    await generate.click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await expect(dialog.getByRole('textbox')).toHaveValue('A paper planner for busy parents')
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
    const choices = dialog.getByRole('list', { name: 'Ideas' }).getByRole('button')
    await expect(choices).toHaveCount(5)
    await choices.nth(2).click()
    await expect(dialog).toHaveCount(0)
    await expect(text).toHaveValue('Scripted idea 3\nfor this product')

    // An answer that arrives after Cancel changes nothing.
    await page.unroute(ideas)
    await page.route(ideas, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      await route.continue()
    })
    await page.getByRole('button', { name: 'Write text for video 1 with AI', exact: true }).click()
    const late = page.waitForResponse(ideas)
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await late
    await expect(dialog).toHaveCount(0)
    await expect(text).toHaveValue('Scripted idea 3\nfor this product')
    await page.unroute(ideas)

    // Clips: a closing clip outside 3 to 15 seconds is refused before it uploads (ST-044).
    await page
      .getByLabel('Clip for video 1', { exact: true })
      .setInputFiles('test/e2e/fixtures/ugc-clip.mp4')
    await expect(concepts.getByText('Clip 3.0 s')).toBeVisible()
    await page
      .getByLabel('Closing clip for video 1', { exact: true })
      .setInputFiles('test/e2e/fixtures/ugc-short.mp4')
    await expect(concepts.getByRole('alert')).toContainText('must be 3 to 15 seconds long')
    // A landscape closing clip at 25 fps still renders into the 9:16, 30 fps frame.
    await page
      .getByLabel('Closing clip for video 1', { exact: true })
      .setInputFiles('test/e2e/fixtures/ugc-closing.mp4')
    await expect(concepts.getByText('Clip 3.0 s · closing clip 3.0 s')).toBeVisible()

    await app.reload()
    await expect(text).toHaveValue('Scripted idea 3\nfor this product')
    await expect(bottom).toHaveAttribute('aria-pressed', 'true')
    await expect(concepts.getByText('Ready to render', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Render 1 video', exact: true }).click()
    await expect(concepts.getByText('Done', { exact: true })).toBeVisible({ timeout: 300_000 })
    await app.reload()
    await expect(concepts.getByText('Done', { exact: true })).toBeVisible()

    const media = (await readBatch(page)).items[0]!.media[0]!
    expect([media.width, media.height]).toEqual([1080, 1920])
    expect(media.durationMs).toBeGreaterThanOrEqual(5900)
    expect(media.durationMs).toBeLessThanOrEqual(6100)
    const file = await assetBytes(page, media.assetId)
    const tracks = readMp4Tracks(file)
    // The clips' own sound is kept.
    expect(tracks.map((track) => track.codec).sort()).toEqual(['avc1', 'mp4a'])
    const decoded = await decodeMp4(
      page,
      file,
      tracks.find((track) => track.handler === 'vide')!
    )
    expect(decoded.decodedFrames).toBe(180)
    expect(decoded.during).toBeGreaterThan(0.01)

    const drafts = await saveBatchDrafts(page)
    expect(drafts).toHaveLength(1)
    const draft = (await apiRequest(page, `/api/v1/content-drafts/${drafts[0]}`)).body as {
      assetIds: string[]
      plainText: string
    }
    expect(draft.assetIds).toEqual([media.assetId])
    // The publishing caption followed the video's text, on one line.
    expect(draft.plainText).toBe('Scripted idea 3 for this product')
  }
)

import sharp from 'sharp'
import { z } from 'zod'
import {
  apiRequest,
  chooseOption,
  db,
  draftEditor,
  editorMore,
  expect,
  expectSaved,
  openNewDraft,
  settleSelection,
  test,
} from './framework'

/** The part of a saved draft these flows read back. */
const savedOptionsSchema = z.object({
  platformVersions: z.object({
    versions: z.array(
      z.object({ channel: z.string(), options: z.record(z.string(), z.unknown()).optional() })
    ),
  }),
})

async function savedOptions(page: Parameters<typeof apiRequest>[0], id: string, channel: string) {
  const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
  expect(saved.status).toBe(200)
  return savedOptionsSchema
    .parse(saved.body)
    .platformVersions.versions.find((version) => version.channel === channel)?.options
}

test(
  'Instagram collaborators, tags and a trial reel are saved, and reel settings need one video',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['instagram-standalone'] })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('Launch day.')
    const photo = await sharp({
      create: { width: 1080, height: 1080, channels: 3, background: '#3355aa' },
    })
      .jpeg()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo })
    await expect(draftEditor(page).locator('figure')).toHaveCount(1)
    await page.getByTestId('platform-tab-instagram').click()
    await page.getByTestId('options-chip').click()
    const options = page.getByTestId('instagram-options')
    await options.getByLabel('Collaborators').fill('@partner bad! @Partner')
    // An invalid handle is named and left out; the same account is kept once.
    await expect(options).toContainText('Not added: bad!')
    await options.getByLabel('Tag accounts').fill('@brand')
    await options.getByLabel('Trial reel').check()
    await expectSaved(page)
    expect(await savedOptions(page, id, 'instagram')).toMatchObject({
      instagram: {
        collaborators: ['partner'],
        userTags: ['brand'],
        trialReel: true,
        trialGraduation: 'MANUAL',
      },
    })
    // A trial reel on a photo blocks scheduling with the reason.
    await expect(page.getByTestId('blockers')).toContainText('is for a reel')
    // A reel's cover is a JPEG of the workspace, chosen in the same place.
    const cover = await sharp({
      create: { width: 1080, height: 1920, channels: 3, background: '#aa5533' },
    })
      .jpeg()
      .toBuffer()
    await options
      .getByLabel('Reel cover')
      .setInputFiles({ name: 'cover.jpg', mimeType: 'image/jpeg', buffer: cover })
    await expect(options).toContainText('Reel cover added')
    await expectSaved(page)
    const withCover = await savedOptions(page, id, 'instagram')
    expect(withCover).toMatchObject({ instagram: { coverAssetId: expect.any(String) } })

    await app.reload()
    await page.getByTestId('platform-tab-instagram').click()
    await page.getByTestId('options-chip').click()
    const reloaded = page.getByTestId('instagram-options')
    await expect(reloaded.getByLabel('Collaborators')).toHaveValue('@partner')
    await expect(reloaded.getByLabel('Tag accounts')).toHaveValue('@brand')
    await expect(reloaded.getByLabel('Trial reel')).toBeChecked()
    await reloaded.getByLabel('Trial reel').uncheck()
    await expectSaved(page)
    const after = await savedOptions(page, id, 'instagram')
    expect(after).toMatchObject({ instagram: { collaborators: ['partner'], userTags: ['brand'] } })
    expect(JSON.stringify(after)).not.toContain('trialReel')
  }
)

test(
  'YouTube tags and the synthetic-content disclosure are saved, and tags over 500 characters block',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['youtube'] })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('A product demo.')
    await page.getByTestId('platform-tab-youtube').click()
    const settings = page.getByTestId('required-options')
    await settings.getByLabel('YouTube tags').fill('launch, product demo, Launch')
    // 6 + 12 and its quotes + one comma; the repeated tag is dropped.
    await expect(settings.getByTestId('youtube-tags-count')).toHaveText('21/500')
    await settings.getByLabel('Altered or synthetic content').check()
    await expectSaved(page)
    expect(await savedOptions(page, id, 'youtube')).toMatchObject({
      youtube: { tags: ['launch', 'product demo'], containsSyntheticMedia: true },
    })
    await app.reload()
    await page.getByTestId('platform-tab-youtube').click()
    const reloaded = page.getByTestId('required-options')
    await expect(reloaded.getByLabel('YouTube tags')).toHaveValue('launch, product demo')
    await expect(reloaded.getByLabel('Altered or synthetic content')).toBeChecked()
    const many = Array.from({ length: 101 }, (_, index) => `t${String(index).padStart(3, '0')}`)
    await reloaded.getByLabel('YouTube tags').fill(many.join(', '))
    await expect(reloaded.getByTestId('youtube-tags-count')).toHaveText('504/500')
    await expect(reloaded.getByLabel('YouTube tags')).toHaveAttribute('aria-invalid', 'true')
    await expectSaved(page)
    await expect(page.getByTestId('blockers')).toContainText(
      'Keep YouTube tags under 500 characters together.'
    )
  }
)

test(
  'UX-02: the account switches work from the keyboard and say why one is off',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewDraft(page)
    const tab = page.getByTestId('platform-tab-linkedin')
    await tab.click()
    await expect(tab).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('platform-tab-x')).toHaveAttribute('aria-pressed', 'false')
    const linkedin = page.getByRole('switch', { name: 'Publish to LinkedIn', exact: true })
    const before = await linkedin.getAttribute('aria-checked')
    await page.keyboard.press('Tab')
    await expect(linkedin).toBeFocused()
    await page.keyboard.press('Space')
    await expect(linkedin).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
    await page.keyboard.press('Space')
    await expect(linkedin).toHaveAttribute('aria-checked', before ?? 'false')

    // LinkedIn takes no X article: its switch is off, and the reason is read out with it.
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        kind: 'article',
        article: { title: 'An X article' },
        body: [{ type: 'p', children: [{ text: 'An article.' }] }],
      },
    })
    expect(created.status).toBe(201)
    await app.open(`/publish/${z.object({ id: z.string() }).parse(created.body).id}`)
    await expect(draftEditor(page)).toBeVisible()
    const refused = page.getByRole('switch', { name: 'Publish to LinkedIn', exact: true })
    await expect(refused).toHaveAttribute('aria-disabled', 'true')
    await expect(refused).toHaveAccessibleDescription('LinkedIn does not take this kind of draft.')
    // It stays in the tab order, so a keyboard reaches it, and Space changes nothing.
    await page.getByTestId('platform-tab-linkedin').click()
    await page.keyboard.press('Tab')
    await expect(refused).toBeFocused()
    await page.keyboard.press('Space')
    await expect(refused).toHaveAttribute('aria-checked', 'false')
  }
)

test(
  'an Instagram story takes a 9:16 photo the feed refuses, and goes out without the text',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['instagram-standalone'] })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('This text goes to the other platforms.')
    const portrait = await sharp({
      create: { width: 1080, height: 1920, channels: 3, background: '#335577' },
    })
      .jpeg()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'story.jpg', mimeType: 'image/jpeg', buffer: portrait })
    await expect(draftEditor(page).locator('figure')).toHaveCount(1)
    await expectSaved(page)
    const schedule = async () => {
      const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
      const { version } = z.object({ version: z.number() }).parse(saved.body)
      return apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
        body: {
          channelConnectionIds: [workspace.channels['instagram-standalone']],
          scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
          version,
        },
        method: 'POST',
      })
    }
    // The feed takes 4:5 to 1.91:1, so the backend refuses the 9:16 photo there.
    const refused = await schedule()
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('4:5 portrait')

    await page.getByTestId('platform-tab-instagram').click()
    await page.getByTestId('options-chip').click()
    const options = page.getByTestId('instagram-options')
    await options.getByLabel('Collaborators').fill('@partner')
    await expectSaved(page)
    // A story takes no collaborators: turning it on clears them, so the draft still saves.
    await options.getByLabel('Post as a story').check()
    await expect(page.getByTestId('story-notice')).toBeVisible()
    await expect(options.getByLabel('Collaborators')).toHaveCount(0)
    await expectSaved(page)
    expect((await savedOptions(page, id, 'instagram'))?.instagram).toEqual({ placement: 'story' })

    const response = await schedule()
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    const postId = z.object({ posts: z.array(z.object({ id: z.string() })) }).parse(response.body)
      .posts[0]!.id
    expect(
      await db.row(
        `SELECT caption, "publishOptions"->'instagram'->>'placement' AS placement FROM scheduled_post WHERE id = $1`,
        [postId]
      )
    ).toEqual({ caption: '', placement: 'story' })
  }
)

test(
  'UP-03: a crop saves a new image from the original for the attachment and keeps the original',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('A cropped launch shot.')
    // Red on the left half and blue on the right, so a crop's position shows in its pixels.
    const wide = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: '#0000ff' },
    })
      .composite([
        {
          input: {
            create: { width: 600, height: 600, channels: 3, background: '#ff0000' },
          },
          left: 0,
          top: 0,
        },
      ])
      .jpeg()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'wide.jpg', mimeType: 'image/jpeg', buffer: wide })
    await expect(draftEditor(page).locator('figure')).toHaveCount(1)
    await expectSaved(page)
    const image = async () => {
      const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
      return z
        .object({ body: z.array(z.record(z.string(), z.unknown())) })
        .parse(saved.body)
        .body.find((node) => node.type === 'img')!
    }
    const stored = async (assetId: unknown) => {
      const response = await page.request.get(`/api/v1/assets/${String(assetId)}/content`)
      expect(response.ok()).toBe(true)
      return sharp(await response.body())
    }
    const original = String((await image()).assetId)
    const crop = async (shape: string) => {
      await editorMore(page, 'Manage media')
      await page
        .getByTestId('media-manager')
        .getByRole('button', { name: 'Crop', exact: true })
        .click()
      const dialog = page.getByRole('dialog', { name: 'Crop image' })
      await chooseOption(dialog.getByRole('combobox', { name: 'Crop shape' }), shape)
      return dialog
    }

    const dialog = await crop('Portrait 4:5')
    // A portrait from a landscape moves only sideways; Home moves it to the left edge.
    await expect(dialog.getByRole('slider', { name: 'Vertical position' })).toHaveCount(0)
    await dialog.getByRole('slider', { name: 'Horizontal position' }).focus()
    await page.keyboard.press('Home')
    await dialog.getByRole('button', { name: 'Apply crop', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectSaved(page)
    const cropped = await image()
    expect(cropped).toMatchObject({
      sourceAssetId: original,
      width: 480,
      height: 600,
      cropSettings: { ratio: 0.8, x: 0, y: 0.5 },
    })
    expect(cropped.assetId).not.toBe(original)
    const bytes = await stored(cropped.assetId)
    const metadata = await bytes.metadata()
    expect([metadata.width, metadata.height, metadata.format]).toEqual([480, 600, 'jpeg'])
    const [red, , blue] = (await bytes.stats()).channels
    expect(red.mean).toBeGreaterThan(200)
    expect(blue.mean).toBeLessThan(50)
    // The original is unchanged in the library.
    const kept = await (await stored(original)).metadata()
    expect([kept.width, kept.height]).toEqual([1200, 600])

    // Cropping again starts from the original, not from the earlier crop.
    const again = await crop('Wide 16:9')
    await again.getByRole('button', { name: 'Apply crop', exact: true }).click()
    await expect(again).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectSaved(page)
    expect(await image()).toMatchObject({
      sourceAssetId: original,
      width: 1067,
      height: 600,
      cropSettings: { ratio: 16 / 9 },
    })
  }
)

test(
  'past captions search the workspace’s other drafts and put the text where the cursor is',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    for (const text of ['Our launch checklist is live.', 'Office hours on Friday.']) {
      const created = await apiRequest(page, '/api/v1/content-drafts', {
        method: 'POST',
        body: { body: [{ type: 'p', children: [{ text }] }], plainText: text },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
    }
    await openNewDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await editorMore(page, 'Past captions…')
    const dialog = page.getByTestId('past-captions')
    await dialog.getByLabel('Search past captions').fill('launch')
    const choice = dialog.getByRole('button', { name: /Our launch checklist is live\./ })
    await expect(choice).toBeVisible()
    await expect(dialog.getByRole('button', { name: /Office hours/ })).toHaveCount(0)
    await choice.click()
    await expect(dialog).toHaveCount(0)
    await expect(draftEditor(page)).toContainText('Our launch checklist is live.')
    await expectSaved(page)
  }
)

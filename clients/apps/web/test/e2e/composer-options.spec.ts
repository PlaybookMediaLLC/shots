import sharp from 'sharp'
import { z } from 'zod'
import {
  apiRequest,
  draftEditor,
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

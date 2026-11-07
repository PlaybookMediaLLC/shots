import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  apiRequest,
  chooseChannels,
  db,
  draftEditor,
  expect,
  expectSaved,
  openSchedule,
  type Page,
  previewOf,
  readMp4Tracks,
  settleSelection,
  test,
} from './framework'

/**
 * Publishing straight from the screenshot editor: Publish opens the draft in
 * the publishing workspace over the design (the full composer, at 90% of the
 * viewport), the export joins the post when it is stored, and the post is
 * written, adapted per platform, previewed and scheduled there. Closing it
 * returns to the design as it was. Posts are scheduled for later, so nothing
 * publishes during the test.
 */

test.use({ actionTimeout: 30_000, viewport: { height: 900, width: 1440 } })

const workspaceDialog = (page: Page) => page.getByTestId('publish-workspace')

/** Choose what to publish in the Publish menu and open the workspace; returns the draft id. */
async function publishFromEditor(
  page: Page,
  choices: { into?: string; kind: string }
): Promise<string> {
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const menu = page.getByTestId('publish-menu')
  await menu.getByRole('radio', { name: choices.kind, exact: true }).click()
  if (choices.into) {
    await expect(menu.getByRole('radio', { name: choices.into, exact: true })).toBeChecked()
  }
  await menu.getByRole('button', { name: 'Open Publish', exact: true }).click()
  await expect(workspaceDialog(page)).toBeVisible({ timeout: 60_000 })
  await page.waitForURL(/\/publish\/[^/]+$/)
  return new URL(page.url()).pathname.split('/').pop() ?? ''
}

type PostRow = { assetIds: string[]; caption: string; platform: string; status: string }

async function draftPosts(draftId: string): Promise<PostRow[]> {
  return await db.rows<PostRow>(
    `SELECT p.caption, p."assetIds", c.platform, p.status::text AS status
       FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
       WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
}

test(
  'a carousel from the editor is written, adapted per platform, previewed and scheduled in the publishing workspace',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await app.openEditor()
    const screenshot = await readFile(resolve('public/store-screenshot-create.png'))
    await page.getByLabel('Add slides', { exact: true }).setInputFiles([
      { buffer: screenshot, mimeType: 'image/png', name: 'one.png' },
      { buffer: screenshot, mimeType: 'image/png', name: 'two.png' },
    ])
    await expect(page.getByRole('button', { name: 'Select slide 2', exact: true })).toBeAttached()

    // Publish opens the composer at once, over the design, which stays mounted but inert.
    const draftId = await publishFromEditor(page, { kind: 'All 2 slides' })
    const box = await workspaceDialog(page).boundingBox()
    expect(box && Math.round(box.width)).toBe(Math.round(1440 * 0.9))
    expect(box && Math.round(box.height)).toBe(Math.round(900 * 0.9))
    await expect(page.locator('[data-platform-shell]')).toHaveAttribute('inert', '')
    // Compose and preview side by side; the preview needs no toggle here.
    await expect(page.getByTestId('workspace-side-column')).toBeVisible()
    await expect(page.getByTestId('preview-panel')).toBeVisible()

    // The slides arrive as the first post's attachments, in order, once stored.
    await expect(page.getByTestId('media-strip-item')).toHaveCount(2, { timeout: 120_000 })
    await expect(page.getByTestId('incoming-media')).toHaveCount(0)

    // A thread for X; LinkedIn gets its own text.
    await chooseChannels(page, ['x', 'linkedin'])
    await draftEditor(page).locator('p').first().click()
    await settleSelection(page)
    await page.keyboard.type('Two new screens, straight from the editor.')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.keyboard.type('More on the release soon.')
    await expectSaved(page)
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expect(page.getByTestId('preview-x')).toContainText('Two new screens')

    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit for LinkedIn independently' }).click()
    await expect(page.getByTestId('manual-version-linkedin')).toBeVisible()
    await draftEditor(page).getByText('More on the release soon.').click()
    await settleSelection(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' Read more on our blog.')
    await expectSaved(page)
    await expect(page.getByTestId('platform-tab-linkedin')).toContainText('Own text')
    await expect(await previewOf(page, 'linkedin')).toContainText('Read more on our blog.')
    await page.getByTestId('platform-tab-x').click()
    await expect(draftEditor(page)).not.toContainText('Read more on our blog.')

    // Closing returns to the design exactly as it was.
    await page.getByRole('button', { name: 'Close Publish', exact: true }).click()
    await app.expectPath('/editor')
    await expect(workspaceDialog(page)).toHaveCount(0)
    await expect(page.locator('[data-platform-shell]')).not.toHaveAttribute('inert', '')
    await expect(page.getByRole('button', { name: 'Select slide 2', exact: true })).toBeAttached()

    // Publishing again offers the same draft; the picture joins its first post.
    const again = await publishFromEditor(page, {
      into: 'The draft you opened last',
      kind: 'Image',
    })
    expect(again).toBe(draftId)
    await expect(page.getByTestId('media-strip-item')).toHaveCount(3, { timeout: 120_000 })
    await expectSaved(page)

    // Scheduling works inside the workspace: one post per platform. The next
    // draft opens in the workspace too, and closing still returns to the design.
    const schedule = await openSchedule(page)
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await expect(schedule.getByLabel('Open a new draft after scheduling')).toBeChecked()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await page.waitForURL(
      (url) => /\/publish\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(draftId)
    )
    await expect(workspaceDialog(page)).toBeVisible()
    await expect.poll(async () => (await draftPosts(draftId)).length, { timeout: 30_000 }).toBe(2)
    await page.getByRole('button', { name: 'Close Publish', exact: true }).click()
    await app.expectPath('/editor')
    await expect(workspaceDialog(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Select slide 2', exact: true })).toBeAttached()
    const posts = await draftPosts(draftId)
    expect(posts.map((post) => [post.platform, post.status])).toEqual([
      ['linkedin', 'SCHEDULED'],
      ['x', 'SCHEDULED'],
    ])
    const x = posts.find((post) => post.platform === 'x')!
    const linkedin = posts.find((post) => post.platform === 'linkedin')!
    expect(x.caption).toMatch(/^Two new screens, straight from the editor\./)
    expect(linkedin.caption).toContain('Read more on our blog.')
    // X carries both slides then the picture. LinkedIn's own text was taken
    // before the picture arrived, so it keeps the two slides it was given.
    expect(new Set(x.assetIds).size).toBe(3)
    expect(linkedin.assetIds).toEqual(x.assetIds.slice(0, 2))

    // The draft is stored, not held by the overlay: opened directly, it is the full Publish page.
    const stored = await apiRequest(page, `/api/v1/content-drafts/${draftId}`)
    expect(stored.status, JSON.stringify(stored.body)).toBe(200)
    expect((stored.body as { assetIds: string[] }).assetIds).toEqual(
      expect.arrayContaining(x.assetIds)
    )
    await app.open(`/publish/${draftId}`)
    await expect(workspaceDialog(page)).toHaveCount(0)
    await expect(draftEditor(page)).toContainText('Two new screens', { timeout: 60_000 })
    await expect(page.getByTestId('media-strip-item')).toHaveCount(3)
    await expect(page.getByTestId('draft-status')).toHaveText('Scheduled')
    // Moving between drafts in Publish never opens the workspace
    // (write-media.spec.ts covers the draft rail).
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  }
)

/** The stored bytes of a draft's only attachment, once it has arrived. */
async function onlyAttachment(page: Page, draftId: string): Promise<Buffer> {
  await expect(page.getByTestId('media-strip-item')).toHaveCount(1, { timeout: 180_000 })
  await expectSaved(page)
  const draft = await apiRequest(page, `/api/v1/content-drafts/${draftId}`)
  const { assetIds } = draft.body as { assetIds: string[] }
  expect(assetIds).toHaveLength(1)
  const stored = await page.request.get(`/api/v1/assets/${assetIds[0]}/content`)
  expect(stored.status()).toBe(200)
  return await stored.body()
}

test(
  'a design publishes as a video or a GIF made by the editor’s own encoders',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await app.openEditor()
    const screenshot = await readFile(resolve('public/store-screenshot-create.png'))
    await page
      .getByLabel('Add slides', { exact: true })
      .setInputFiles({ buffer: screenshot, mimeType: 'image/png', name: 'one.png' })
    await expect(page.getByRole('button', { name: 'Remove screenshot', exact: true })).toBeEnabled()

    // The video arrives as an H.264 MP4 and plays in the preview.
    const videoDraft = await publishFromEditor(page, { kind: 'Video (MP4)' })
    const video = readMp4Tracks(await onlyAttachment(page, videoDraft)).find(
      (track) => track.handler === 'vide'
    )
    expect(video?.codec).toBe('avc1')
    expect(video!.duration).toBeGreaterThan(0)
    await expect(page.getByTestId('preview-x').locator('video')).toHaveCount(1)

    // A GIF goes into a post of its own when asked: X takes a video or a GIF, not both.
    await page.getByRole('button', { name: 'Close Publish', exact: true }).click()
    await app.expectPath('/editor')
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    const menu = page.getByTestId('publish-menu')
    await menu.getByRole('radio', { name: 'GIF', exact: true }).click()
    await expect(menu.getByRole('radio', { name: 'The draft you opened last' })).toBeChecked()
    await menu.getByRole('radio', { name: 'A new post', exact: true }).click()
    await menu.getByRole('button', { name: 'Open Publish', exact: true }).click()
    await page.waitForURL(
      (url) => /\/publish\/[^/]+$/.test(url.pathname) && !url.pathname.endsWith(videoDraft)
    )
    const gifDraft = new URL(page.url()).pathname.split('/').pop() ?? ''
    const gif = await onlyAttachment(page, gifDraft)
    expect(gif.subarray(0, 6).toString('latin1')).toBe('GIF89a')
  }
)

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { apiRequest, expect, type Page, test } from './framework'

/**
 * Publishing straight from the screenshot editor (no download, no reupload):
 * the design is rendered by the export pipeline, stored as a workspace asset,
 * and handed to the ordinary content draft lifecycle.
 */

test.use({ actionTimeout: 30_000, workspaceOptions: { channels: ['x'], plan: 'pro' } })

/** The dialog the Publish action opens. */
const publishDialog = (page: Page) => page.getByTestId('editor-publish')

/** A screenshot on a design the editor has visibly changed, ready to publish. */
async function composeDesign(page: Page, headline: string): Promise<void> {
  const source = await readFile(resolve('public/store-screenshot-create.png'))
  await page
    .getByLabel('Add slides', { exact: true })
    .setInputFiles({ buffer: source, mimeType: 'image/png', name: 'release.png' })
  await page.getByRole('button', { name: 'Add Text', exact: true }).first().click()
  const content = page.getByRole('textbox', { name: 'Text content', exact: true })
  await content.click()
  await content.fill(headline)
}

/** Open Publish and wait until the render is stored, with the X account chosen. */
async function openPublish(page: Page, caption: string) {
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  const dialog = publishDialog(page)
  const facts = dialog.getByTestId('publish-image-facts')
  await expect(facts).toBeVisible({ timeout: 120_000 })
  await expect(dialog.getByText('Saved to your workspace.', { exact: true })).toBeVisible({
    timeout: 120_000,
  })
  await dialog.getByRole('checkbox', { name: 'Publish to Shots on x' }).check()
  await dialog.getByRole('textbox', { name: 'Caption', exact: true }).fill(caption)
  // Nothing blocks the post: an unpublishable design would list why here.
  await expect(dialog.getByTestId('publish-blockers')).toHaveCount(0)
  const [width, height] = (await facts.innerText())
    .split('·')[0]
    .split('×')
    .map((part) => Number(part.trim()))
  return { dialog, size: { height, width } }
}

/** The newest draft of this workspace, as the API returns it. */
async function newestDraft(page: Page) {
  const response = await apiRequest(page, '/api/v1/content-drafts?limit=5')
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  const body = response.body as {
    items: { assetIds: string[]; id: string; plainText: string }[]
    pinned: { assetIds: string[]; id: string; plainText: string }[]
  }
  const [draft] = [...body.pinned, ...body.items]
  expect(draft, 'the editor created a draft').toBeTruthy()
  return draft
}

test(
  'a design published from the editor becomes a draft carrying the rendered composition',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace()
    await app.openEditor()
    await composeDesign(page, 'Shipped today')

    const { dialog, size } = await openPublish(page, 'Our new editor, straight from the canvas.')
    await dialog.getByRole('button', { name: 'Save as draft', exact: true }).click()
    await expect(dialog.getByText('Saved as a draft', { exact: true })).toBeVisible()

    const draft = await newestDraft(page)
    expect(draft.plainText).toContain('straight from the canvas')
    // One attachment, referenced by asset id: no base64 body, no second upload.
    expect(draft.assetIds).toHaveLength(1)

    // The stored bytes are the ones the dialog showed, so what publishes is
    // what the person approved.
    const stored = await page.request.get(`/api/v1/assets/${draft.assetIds[0]}/content`)
    expect(stored.status()).toBe(200)
    const metadata = await sharp(await stored.body()).metadata()
    expect([metadata.width, metadata.height]).toEqual([size.width, size.height])

    // The draft is an ordinary post in Publish, with the image attached.
    await dialog.getByRole('button', { name: 'Open the draft', exact: true }).click()
    await app.expectPath(`/publish/${draft.id}`)
    await expect(page.getByTestId('media-strip-item')).toHaveCount(1)
    expect(errors).toEqual([])
  }
)

test(
  'a scheduled design keeps the exact image it was scheduled with',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace()
    await app.openEditor()
    await composeDesign(page, 'Launch week')

    const { dialog } = await openPublish(page, 'Launch week starts now.')
    // The default is tomorrow at 09:00 in the profile's zone.
    await dialog.getByRole('button', { name: 'Schedule', exact: true }).click()
    await expect(dialog.getByText('Scheduled', { exact: true })).toBeVisible({ timeout: 60_000 })

    const draft = await newestDraft(page)
    const scheduled = await apiRequest(page, `/api/v1/content-drafts/${draft.id}/posts`)
    expect(scheduled.status).toBe(200)
    const { posts } = scheduled.body as {
      posts: { caption: string; channelConnectionId: string; status: string }[]
    }
    expect(posts).toHaveLength(1)
    expect(posts[0].channelConnectionId).toBe(workspace.channels.x)
    expect(posts[0].status).toBe('SCHEDULED')
    expect(posts[0].caption).toContain('Launch week starts now.')

    // Editing the design afterwards leaves the queued post alone: a later
    // export is a new asset, never a replacement of published bytes.
    await dialog.getByRole('button', { name: 'Back to the design', exact: true }).click()
    const content = page.getByRole('textbox', { name: 'Text content', exact: true })
    await content.click()
    await content.fill('Launch week, revised')
    await expect.poll(async () => (await newestDraft(page)).assetIds).toEqual(draft.assetIds)
  }
)

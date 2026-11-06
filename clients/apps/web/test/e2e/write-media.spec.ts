import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import {
  apiRequest,
  caretAtDocumentEnd,
  chooseOption,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  settleSelection,
  signedAssetSchema,
  startHttpMockServer,
  test,
  trpcMutation,
  uploadSignedAsset,
  editorMore,
} from './framework'

test(
  'TF-068: paid large-image upload and X resizing preserve the original; over-limit selection preserves authored text',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const id = await openNewDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await page.keyboard.type('Large image with its original preserved.')
    const input = page.locator('input[type=file][aria-label="Insert media"]')
    let uploadRequests = 0
    page.on('request', (request) => {
      if (request.url().includes('asset.signUpload')) uploadRequests++
    })
    await input.setInputFiles({
      name: 'over-limit.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(20_000_001),
    })
    await expect(page.getByText(/over-limit.png.*too large/)).toBeVisible()
    expect(uploadRequests).toBe(0)
    await expect(editor).toContainText('Large image with its original preserved.')
    await expect(editor.locator('figure')).toHaveCount(0)
    // Incompressible pixels make a real >5 MB source, not a file padded with junk.
    const png = await sharp(randomBytes(1600 * 1200 * 4), {
      raw: { width: 1600, height: 1200, channels: 4 },
    })
      .png()
      .toBuffer()
    expect(png.length).toBeGreaterThan(5_000_000)
    expect(png.length).toBeLessThan(20_000_000)
    await input.setInputFiles({ name: 'large-image.png', mimeType: 'image/png', buffer: png })
    await expect(editor.locator('figure')).toHaveCount(1)
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    const original = (saved.body as { body: { type: string; assetId?: string }[] }).body.find(
      (node) => node.type === 'img'
    )!.assetId!
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1)
    const scheduled = await scheduledAssets(id, 'x')
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]).not.toBe(original)
    const stored = await page.request.get(`/api/v1/assets/${original}/content`)
    expect(Buffer.compare(await stored.body(), png)).toBe(0)
    const resized = await page.request.get(`/api/v1/assets/${scheduled[0]}/content`)
    const bytes = await resized.body()
    expect(bytes.length).toBeLessThanOrEqual(5_000_000)
    const metadata = await sharp(bytes).metadata()
    expect(metadata.width).toBeLessThan(1600)
    expect(metadata.width! / metadata.height!).toBeCloseTo(4 / 3, 2)
    expect(metadata.hasAlpha).toBe(true)
  }
)

test(
  'TF-019 TF-076: fixture GIF search attaches durable animation and rejects mixed X media',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x'] })
    const id = await openNewDraft(page)
    const frame = await sharp({
      create: { width: 120, height: 60, channels: 4, background: '#25a8df' },
    })
      .raw()
      .toBuffer()
    const other = await sharp({
      create: { width: 120, height: 60, channels: 4, background: '#ff8800' },
    })
      .raw()
      .toBuffer()
    const gif = await sharp(Buffer.concat([frame, other]), {
      raw: { width: 120, height: 120, channels: 4, pageHeight: 60 },
    })
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer()
    expect((await sharp(gif).metadata()).pages).toBe(2)
    const sha256 = createHash('sha256').update(gif).digest('hex')
    const signed = await apiRequest(page, '/api/tenant/assets/upload-url', {
      method: 'POST',
      body: {
        bytes: gif.length,
        classification: 'input',
        contentType: 'image/gif',
        fileName: 'fixture-animation.gif',
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
    // Only the GIPHY boundary is substituted. No GIPHY server is contacted,
    // and the fixture animation has real tenant storage.
    await page.route('**/api/v1/content-drafts/giphy*', async (route) => {
      const request = route.request()
      if (request.method() === 'POST') {
        expect(request.postDataJSON()).toEqual({ id: 'local-animation' })
        await route.fulfill({
          json: { assetId: stored.asset.id, sourceUrl: 'https://giphy.com/gifs/local-animation' },
        })
      } else {
        const q = new URL(request.url()).searchParams.get('q')
        if (q === 'rate-limit')
          await route.fulfill({
            status: 503,
            json: { error: 'GIPHY search is rate limited. Try again later.' },
          })
        else
          await route.fulfill({
            json: {
              items:
                q === 'empty'
                  ? []
                  : [
                      {
                        id: 'local-animation',
                        title: 'Local animation',
                        previewUrl: `/api/v1/assets/${stored.asset.id}/content`,
                        sourceUrl: 'https://giphy.com/gifs/local-animation',
                      },
                    ],
            },
          })
      }
    })
    await draftEditor(page).click()
    await page.keyboard.type('An animated release update.')
    await editorMore(page, 'GIF')
    await page.getByLabel('Search GIFs').fill('empty')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'No GIFs found' })).toBeVisible()
    await page.getByLabel('Search GIFs').fill('rate-limit')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('rate limited')
    await page.getByLabel('Search GIFs').fill('release')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('link', { name: 'Powered by GIPHY' })).toBeVisible()
    await page.getByRole('button', { name: 'Attach Local animation' }).click()
    await expect(draftEditor(page).locator('img')).toHaveCount(1)
    await expectSaved(page)
    await app.reload()
    await expect(draftEditor(page).locator('figure')).toHaveCount(1)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('preview-panel').locator('img')).toHaveCount(1)
    const png = await sharp({
      create: { width: 120, height: 60, channels: 4, background: '#25a8df' },
    })
      .png()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'mixed.png', mimeType: 'image/png', buffer: png })
    await expect(draftEditor(page).locator('figure')).toHaveCount(2)
    await expect(page.getByTestId('preview-panel').getByRole('alert')).toContainText(
      'X posts a video or GIF on its own. Move the other attachments to a separate post.'
    )
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    const body = (saved.body as { body: Record<string, unknown>[] }).body
    const media = body.filter((node) => node.type === 'img')
    expect(media).toHaveLength(2)
    expect(media[0].giphyId).toBe('local-animation')
    const rejected = await apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
      method: 'POST',
      body: {
        channelConnectionIds: [workspace.channels.x],
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        version: (saved.body as { version: number }).version,
      },
    })
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(409)
    expect(JSON.stringify(rejected.body)).toMatch(/mix|GIF/i)
    expect(await scheduledAssets(id, 'x')).toEqual([])
    const bytes = await page.request.get(`/api/v1/assets/${stored.asset.id}/content`)
    expect(Buffer.compare(await bytes.body(), gif)).toBe(0)
    const valid = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('A supported single animation.')
    await editorMore(page, 'GIF')
    await page.getByLabel('Search GIFs').fill('release')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await page.getByRole('button', { name: 'Attach Local animation' }).click()
    await expectSaved(page)
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1)
    expect(await scheduledAssets(valid, 'x')).toEqual([stored.asset.id])
  }
)

async function scheduledAssets(draftId: string, platform: string): Promise<string[]> {
  const result = await db.query<{
    assetIds: string[] | null
    publishOptions: { documentAssetId?: string }
  }>(
    `SELECT p."assetIds", p."publishOptions" FROM scheduled_post p JOIN channel_connection c ON c.id=p."channelConnectionId" WHERE p."contentDraftId"=$1 AND c.platform=$2`,
    [draftId, platform]
  )
  return result.rows.flatMap((row) => [
    ...(row.assetIds ?? []),
    ...(row.publishOptions?.documentAssetId ? [row.publishOptions.documentAssetId] : []),
  ])
}

test(
  'TF-001 TF-007 TF-092: dropped images copy through the clipboard between posts without reupload',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const id = await openNewDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await page.keyboard.type('First post with a dropped image.')
    const png = await sharp({
      create: { width: 120, height: 60, channels: 4, background: '#25a8df' },
    })
      .png()
      .toBuffer()
    await editor.evaluate(
      (node, bytes) => {
        const data = new DataTransfer()
        data.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }))
        const bounds = node.querySelector('[data-slate-string]')!.getBoundingClientRect()
        const event = {
          bubbles: true,
          cancelable: true,
          dataTransfer: data,
          clientX: bounds.x + 5,
          clientY: bounds.y + 5,
        }
        node.dispatchEvent(new DragEvent('dragenter', event))
        node.dispatchEvent(new DragEvent('dragover', event))
        node.dispatchEvent(new DragEvent('drop', event))
      },
      [...png]
    )
    await expect(editor.locator('img')).toHaveCount(1)
    await editorMore(page, 'Manage media')
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: '+ALT', exact: true })
      .click()
    await page.getByLabel('Description of image 1').fill('Dropped and copied blue rectangle.')
    await page.getByRole('button', { name: 'Save descriptions' }).click()
    await expect(page.getByTestId('describe-images')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await editor.locator('img').click()
    await settleSelection(page)
    // Native copy retains Slate's private clipboard format; writing only HTML
    // through ClipboardItem would deliberately discard that media metadata.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.keyboard.press('ControlOrMeta+c')
    await page.getByRole('button', { name: 'Add post', exact: true }).click()
    await page.keyboard.type('Second post receives the copied attachment.')
    await page.keyboard.press('ControlOrMeta+v')
    await expect(editor.locator('figure')).toHaveCount(2)
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    const body = (saved.body as { body: Record<string, unknown>[] }).body
    const images = body.filter((node) => node.type === 'img')
    expect(images).toHaveLength(2)
    expect(images[0].assetId).toBe(images[1].assetId)
    expect(images[0].id).not.toBe(images[1].id)
    expect(images.map((node) => node.alt)).toEqual(
      Array(2).fill('Dropped and copied blue rectangle.')
    )
    await app.reload()
    await expect(editor.locator('figure')).toHaveCount(2)
    await editorMore(page, 'Manage media')
    const manager = page.getByTestId('media-manager')
    await expect(
      manager.getByRole('region', { name: 'Post 1 media' }).locator('[data-attachment-id]')
    ).toHaveCount(1)
    await expect(
      manager.getByRole('region', { name: 'Post 2 media' }).locator('[data-attachment-id]')
    ).toHaveCount(1)
  }
)

test(
  'TF-078 TF-100: preview toggles preserve the caret and scroll while rapid edits and draft switches stay isolated',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x'] })
    const first = await openNewDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await page.keyboard.insertText('Alpha omega.')
    await editor
      .locator('[data-slate-string]')
      .filter({ hasText: 'Alpha omega.' })
      .evaluate((node) => {
        const range = document.createRange()
        range.setStart(node.firstChild!, 6)
        range.collapse(true)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
      })
    // Slate syncs native DOM selection on a 100 ms timer.
    await settleSelection(page)
    const toggle = page.getByRole('button', { name: 'Preview', exact: true })
    await toggle.click()
    await expect(editor).toBeFocused()
    await page.keyboard.type('one ')
    await expect(editor).toContainText('Alpha one omega.')
    await expect(page.getByTestId('preview-panel')).toContainText('Alpha one omega.')
    await toggle.click()
    await expect(editor).toBeFocused()
    await page.keyboard.type('two ')
    await expect(editor).toContainText('Alpha one two omega.')
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('dialog').getByRole('combobox').fill('Preview')
    await page.getByRole('option', { name: /Preview current draft/ }).click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    await expect(editor).toBeFocused()
    await page.keyboard.type('three ')
    await expect(editor).toContainText('Alpha one two three omega.')
    await toggle.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('\n' + 'Independent scrolling and saved content.\n'.repeat(45))
    // The header is sticky; toggling must not remount or scroll the editor.
    const main = page.getByTestId('write-frame').locator('main')
    await main.evaluate((node) => {
      node.scrollTop = 250
    })
    const before = await main.evaluate((node) => node.scrollTop)
    expect(before).toBeGreaterThan(0)
    await toggle.click()
    await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(before)
    const panel = page.getByTestId('preview-panel')
    await panel.getByRole('button', { name: 'Show more', exact: true }).click()
    const previewScroll = panel.getByTestId('preview-scroll')
    await previewScroll.evaluate((node) => {
      node.scrollTop = 100
    })
    expect(await previewScroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect(await main.evaluate((node) => node.scrollTop)).toBe(before)
    await toggle.click()
    expect(await main.evaluate((node) => node.scrollTop)).toBe(before)
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await toggle.click()
    await page.keyboard.type('Rapid-edit-marker-0123456789', { delay: 1 })
    await panel.getByRole('button', { name: 'Show more', exact: true }).click()
    await expect(panel).toContainText('Rapid-edit-marker-0123456789')
    await expectSaved(page)
    const second = await openNewDraft(page)
    await editor.click()
    await page.keyboard.type('Second draft must stay isolated.')
    await toggle.click()
    await expect(panel).toContainText('Second draft must stay isolated.')
    await expect(panel).not.toContainText('Rapid-edit-marker')
    await expectSaved(page)
    // Navigate through the actual draft rail, so the pending-save guard runs.
    // An open preview hides the rail below 1536px wide, so it closes first.
    if (await panel.isVisible()) await toggle.click()
    await page.locator(`a[href^="/publish/${first}"]`).first().click()
    await expect(editor).toContainText('Rapid-edit-marker-0123456789')
    if (!(await panel.isVisible())) await toggle.click()
    await expect(panel).not.toContainText('Second draft must stay isolated.')
    await panel.getByRole('button', { name: 'Show more', exact: true }).click()
    await expect(panel).toContainText('Rapid-edit-marker-0123456789')
    await toggle.click()
    await page.locator(`a[href^="/publish/${second}"]`).first().click()
    await expect(editor).toContainText('Second draft must stay isolated.')
    await expect(editor).not.toContainText('Alpha one two')
    expect(errors).toEqual([])
  }
)

test(
  'TF-007 TF-023 TF-092: upload, describe, copy, reorder, frame and reopen durable media',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const brand = await trpcMutation(page, 'brandKit.create', {
      definition: {
        colors: { accent: '#6366f1', background: '#ffffff', text: '#111111' },
        schemaVersion: 1,
        typography: { headingFamily: 'inter' },
      },
      name: 'Media frame brand',
      publish: true,
    })
    expect(brand.status).toBe(200)
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('Media release — durable attachments.')
    const png = await sharp({
      create: { width: 400, height: 200, channels: 4, background: '#25a8df' },
    })
      .png()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'media-test.png', mimeType: 'image/png', buffer: png })
    await expect(draftEditor(page).locator('img')).toHaveCount(1)
    await editorMore(page, 'Manage media')
    const manager = page.getByTestId('media-manager')
    await manager.getByRole('button', { name: '+ALT', exact: true }).click()
    await page
      .getByLabel('Description of image 1')
      .fill('A blue rectangle used to test accessible media.')
    await page.getByRole('button', { name: 'Save descriptions' }).click()
    await expect(page.getByTestId('describe-images')).toHaveCount(0)
    await manager.getByRole('button', { name: 'Copy', exact: true }).click()
    await expect(manager.locator('[data-attachment-id]')).toHaveCount(2)
    const originalOrder = await manager
      .locator('[data-attachment-id]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-attachment-id')))
    await manager
      .getByLabel('Drag attachment')
      .last()
      .dragTo(manager.locator('[data-attachment-id]').first())
    await manager.getByRole('button', { name: 'Move attachment later' }).first().click()
    await manager.getByRole('button', { name: 'Move attachment earlier' }).last().click()
    expect(
      await manager
        .locator('[data-attachment-id]')
        .evaluateAll((items) => items.map((item) => item.getAttribute('data-attachment-id')))
    ).toEqual(originalOrder.reverse())
    await manager.getByRole('button', { name: 'Frame', exact: true }).first().click()
    await page.getByLabel('Frame color').click()
    await page.getByLabel('Hex color').fill('#ff8800')
    await page.getByLabel('Hex color').press('Enter')
    await expect(page.getByLabel('Frame color')).toContainText(/ff8800/i)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Use brand color #6366f1' }).click()
    await page.getByRole('button', { name: 'Preview frame', exact: true }).click()
    await expect(page.getByAltText('Framed image preview')).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Apply frame', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Frame image' })).toHaveCount(0)
    await manager.getByRole('button', { name: 'Frame', exact: true }).first().click()
    await expect(page.getByLabel('Frame color')).toContainText(/#6366f1/i)
    await page.getByLabel('Frame color').click()
    await page.getByLabel('Hex color').fill('#ff8800')
    await page.getByLabel('Hex color').press('Enter')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.keyboard.press('Escape')
    await draftEditor(page).click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.keyboard.type('Second post with copied media.')
    await editorMore(page, 'Manage media')
    await chooseOption(manager.getByLabel('Destination post').first(), 'Post 2')
    await manager.getByRole('button', { name: 'Move', exact: true }).first().click()
    await expect(
      manager.getByRole('region', { name: 'Post 2 media' }).locator('[data-attachment-id]')
    ).toHaveCount(1)
    const postOne = manager.getByRole('region', { name: 'Post 1 media' })
    const postTwo = manager.getByRole('region', { name: 'Post 2 media' })
    await postTwo.getByLabel('Drag attachment').dragTo(postOne, { targetPosition: { x: 8, y: 8 } })
    await expect(postOne.locator('[data-attachment-id]')).toHaveCount(2)
    await postOne
      .getByLabel('Drag attachment')
      .last()
      .dragTo(postTwo, { targetPosition: { x: 8, y: 8 } })
    await expect(postTwo.locator('[data-attachment-id]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect(saved.status).toBe(200)
    const draft = saved.body as { body: Record<string, unknown>[] }
    const images = draft.body.filter((node) => node.type === 'img')
    expect(images).toHaveLength(2)
    expect(images[0].assetId).not.toBe(images[1].assetId)
    expect(images[1].sourceAssetId).toBe(images[0].assetId)
    expect(images[1].frameSettings).toEqual({ color: '#6366f1', padding: 32, radius: 12 })
    const exported = await page.request.get(`/api/v1/assets/${images[1].assetId}/content`)
    expect(exported.ok()).toBe(true)
    const output = await sharp(await exported.body()).metadata()
    expect([output.width, output.height, output.format]).toEqual([464, 264, 'png'])
    expect(images.map((node) => node.alt)).toEqual(
      Array(2).fill('A blue rectangle used to test accessible media.')
    )
    await app.reload()
    // The structured editor lazy-loads offscreen image elements.
    await expect(draftEditor(page).locator('figure')).toHaveCount(2)
    await draftEditor(page).locator('figure').last().scrollIntoViewIfNeeded()
    await expect(draftEditor(page).locator('figure').last().locator('img')).toHaveCount(1)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(
      page
        .getByTestId('preview-panel')
        .getByAltText('A blue rectangle used to test accessible media.')
    ).toHaveCount(2)
    await page.getByTestId('preview-panel').screenshot({ path: '.context/shots/media-preview.png' })
    await page.getByRole('button', { name: 'Edit image description' }).first().click()
    await page
      .getByRole('textbox', { name: 'Image description', exact: true })
      .fill('Description edited from the preview.')
    await page.getByRole('button', { name: 'Save description', exact: true }).click()
    await expect(
      page.getByTestId('preview-panel').getByAltText('Description edited from the preview.')
    ).toHaveCount(1)
    expect(errors).toEqual([])
  }
)

test(
  'TF-057 TF-074 TF-078 TF-085 TF-100: live preview, expansion and scaled mobile geometry preserve draft',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    // Wide enough that the drafts rail doesn't squeeze the panel below its full width.
    await page.setViewportSize({ width: 1536, height: 720 })
    await startWorkspace({ channels: ['x', 'linkedin', 'threads'] })
    const id = await openNewDraft(page)
    const text =
      'Preview opening 👨‍👩‍👧‍👦 <script>alert(1)</script>\n\n' +
      'A paragraph about the release with https://example.com/news. '.repeat(8)
    await draftEditor(page).click()
    await page.keyboard.insertText(text)
    await expectSaved(page)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const panel = page.getByTestId('preview-panel')
    // The preview starts on a phone; these baselines are the desktop column.
    await panel.getByRole('combobox', { name: 'Preview device' }).click()
    await page.getByRole('option', { name: 'Desktop', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Show more', exact: true })).toBeVisible()
    await expect(panel).toHaveScreenshot('x-desktop-collapsed.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    await panel.getByRole('button', { name: 'Show more', exact: true }).click()
    await expect(panel.getByText(/Preview opening/)).toContainText('<script>alert(1)</script>')
    await expect(panel).toHaveScreenshot('x-desktop-expanded.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    await panel.getByRole('button', { name: 'Show less', exact: true }).click()
    await panel.getByRole('button', { name: 'LinkedIn', exact: true }).click()
    await expect(panel.getByRole('button', { name: /more/ })).toBeVisible()
    await expect(panel).toHaveScreenshot('linkedin-desktop-collapsed.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    await panel.getByRole('combobox', { name: 'Preview device' }).click()
    await page.getByRole('option', { name: /iPhone SE/ }).click()
    const bounds = await panel.getByTestId('preview-device-content').boundingBox()
    const available = await panel.getByTestId('preview-scroll').boundingBox()
    expect(bounds!.width).toBeLessThanOrEqual(available!.width + 1)
    await expect(panel).toHaveScreenshot('linkedin-mobile-collapsed.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    await panel.getByRole('button', { name: /more/ }).click()
    await expect(panel).toHaveScreenshot('linkedin-mobile-expanded.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    // A click then End can leave the caret where the click landed: set it at the end.
    await caretAtDocumentEnd(page)
    await page.keyboard.type(' Live update.')
    await expect(panel).toContainText('Live update.')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.keyboard.type('A short second post 🚀')
    await panel.getByRole('button', { name: 'Threads', exact: true }).click()
    await expect(panel.locator('article')).toHaveCount(2)
    await expect(panel).toHaveScreenshot('threads-mobile-thread.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    })
    // The picked platform and device survive the panel moving between layouts.
    await expect(panel.getByRole('button', { name: 'Threads', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await expect(panel.getByRole('combobox', { name: 'Preview device' })).toContainText('iPhone SE')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expectSaved(page)
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('dialog').getByRole('combobox').fill('Preview')
    await page.getByRole('option', { name: /Preview current draft/ }).click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await app.reload()
    await expect(draftEditor(page)).toContainText('Live update.')
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect(JSON.stringify(saved.body)).toContain('Live update.')
  }
)

test(
  'TF-019 TF-040 TF-083: blocked GIF approval, unsafe URL rejection, and native PDF preview',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('Document and image preview.')
    // The server refuses until GIPHY approves; the picker says so rather than showing nothing.
    await page.route('**/api/v1/content-drafts/giphy*', (route) =>
      route.fulfill({
        status: 503,
        json: { message: 'GIPHY search is not enabled. Provider approval is still required.' },
      })
    )
    await editorMore(page, 'GIF')
    await page.getByLabel('Search GIFs').fill('release')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('approval')
    await page.keyboard.press('Escape')
    const unsafe = await apiRequest(page, '/api/v1/content-drafts/link-image', {
      method: 'POST',
      body: { url: 'http://127.0.0.1/private' },
    })
    expect(unsafe.status).toBe(422)
    const documentId = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('A two-page native document.')
    await page.getByTestId('platform-tab-linkedin').click()
    const pdf = await readFile(
      '../../../server/internal/social/integrations/social/linkedin/testdata/two-pages.pdf'
    )
    await page.getByTestId('options-chip').click()
    await page
      .locator('input[type=file][aria-label="PDF document"]')
      .setInputFiles({ name: 'two-pages.pdf', mimeType: 'application/pdf', buffer: pdf })
    await page.getByRole('button', { name: 'PDF: two-pages', exact: true }).click()
    await expect(page.getByTestId('pdf-page-count')).toContainText('2 pages')
    await page.getByRole('button', { name: 'Next →', exact: true }).click()
    await expect(page.getByRole('img', { name: /page 2/ })).toBeVisible()
    await page.getByRole('button', { name: '← Previous', exact: true }).click()
    await expect(page.getByRole('img', { name: /page 1/ })).toBeVisible()
    await page.getByTestId('pdf-carousel').screenshot({ path: '.context/shots/pdf-carousel.png' })
    await page.keyboard.press('Escape')
    await expectSaved(page)
    await app.reload()
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByTestId('options-chip').click()
    await expect(page.getByRole('button', { name: 'PDF: two-pages', exact: true })).toBeVisible()
    await page.getByTestId('schedule-button').click()
    await page
      .getByTestId('schedule-dialog')
      .getByRole('button', { name: 'Preview', exact: true })
      .click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    await expect(page.getByTestId('preview-linkedin')).toBeVisible()
    await expect(page.getByTestId('preview-panel').getByTestId('pdf-page-count')).toContainText(
      '2 pages'
    )
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await page.getByTestId('publish-button').click()
    await page
      .getByTestId('publish-review')
      .getByRole('button', { name: 'Preview', exact: true })
      .click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(2)
    const scheduled = await apiRequest(page, `/api/v1/content-drafts/${documentId}/posts`)
    expect(JSON.stringify(scheduled.body)).toContain('SCHEDULED')
    const ids = await scheduledAssets(documentId, 'linkedin')
    expect(ids).toHaveLength(1)
    const storedPDF = await page.request.get(`/api/v1/assets/${ids[0]}/content`)
    expect(storedPDF.ok()).toBe(true)
    expect(Buffer.compare(await storedPDF.body(), pdf)).toBe(0)
  }
)

test(
  'TF-001 TF-007 TF-038: typed provider mentions, photo tags and ALT edits persist across independent versions (local lookup)',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const id = await openNewDraft(page)
    // Only the account lookup is intercepted: editor, saving, asset API and storage are real.
    await page.route('**/api/v1/social-sets/*/mentions?*', async (route) => {
      const url = new URL(route.request().url())
      const q = url.searchParams.get('q')
      if (q === 'slow') await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.fulfill({
        json: {
          items:
            q === 'missing'
              ? []
              : [
                  {
                    handle: q,
                    kind: 'person',
                    label: `Account ${q}`,
                    providerId: q === 'shots' ? '123456789' : '999',
                  },
                ],
        },
      })
    })
    await draftEditor(page).click()
    await page.keyboard.type('Hello @')
    const lookup = page.getByRole('combobox', { name: 'Social account username' })
    await expect(lookup).toBeVisible()
    const slowRequest = page.waitForRequest(
      (request) => request.url().includes('/mentions?') && request.url().includes('q=slow')
    )
    const slowResponse = page.waitForResponse(
      (response) => response.url().includes('/mentions?') && response.url().includes('q=slow')
    )
    await lookup.fill('slow')
    await slowRequest
    await lookup.fill('missing')
    await expect(page.getByRole('status').filter({ hasText: 'No matching account' })).toBeVisible()
    await slowResponse
    await expect(page.getByRole('option', { name: /Account slow/ })).toHaveCount(0)
    await lookup.fill('shots')
    await page.getByRole('option', { name: 'Account shots (@shots)', exact: true }).click()
    await expect(draftEditor(page).getByTestId('social-mention')).toContainText('Account shots')
    const png = await sharp({
      create: { width: 80, height: 60, channels: 4, background: '#ff0044' },
    })
      .png()
      .toBuffer()
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles({ name: 'alt-versions.png', mimeType: 'image/png', buffer: png })
    await expect(draftEditor(page).locator('figure')).toHaveCount(1)
    await editorMore(page, 'Manage media')
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: 'Tag people', exact: true })
      .click()
    await page.getByLabel('X username to tag').fill('shots')
    await page.getByRole('button', { name: 'Find person', exact: true }).click()
    await page.getByRole('button', { name: 'Add Account shots @shots', exact: true }).click()
    await page.getByRole('button', { name: 'Save photo tags', exact: true }).click()
    await page.keyboard.press('Escape')
    await expectSaved(page)
    const tagged = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect(JSON.stringify(tagged.body)).toContain('photoTags')
    const denied = await apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
      method: 'POST',
      body: {
        channelConnectionIds: [workspace.channels.x],
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        version: (tagged.body as { version: number }).version,
      },
    })
    expect(denied.status).toBe(409)
    expect(JSON.stringify(denied.body)).toMatch(/photo.tag|permission|enabled/i)
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit for LinkedIn independently' }).click()
    await editorMore(page, 'Manage media')
    // Remove inherited X metadata without changing the primary X version.
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: 'Remove X photo tags', exact: true })
      .click()
    await expect(
      page.getByTestId('media-manager').getByRole('button', { name: 'Remove X photo tags' })
    ).toHaveCount(0)
    await page
      .getByTestId('media-manager')
      .getByRole('button', { name: '+ALT', exact: true })
      .click()
    await page
      .getByLabel('Description of image 1')
      .fill('Shared description from the independent LinkedIn version.')
    await page.getByRole('button', { name: 'Save descriptions', exact: true }).click()
    await expect(page.getByTestId('describe-images')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect(saved.status).toBe(200)
    const data = saved.body as {
      body: Record<string, unknown>[]
      version: number
      platformVersions: { versions: { channel: string; body?: Record<string, unknown>[] }[] }
    }
    expect(data.body.find((node) => node.type === 'img')?.alt).toBe(
      'Shared description from the independent LinkedIn version.'
    )
    expect(JSON.stringify(data.platformVersions)).toContain(
      'Shared description from the independent LinkedIn version.'
    )
    expect(JSON.stringify(data.body)).toContain('123456789')
    expect(data.body.find((node) => node.type === 'img')?.photoTags).toEqual([
      expect.objectContaining({
        providerId: '123456789',
        handle: 'shots',
        label: 'Account shots',
      }),
    ])
    expect(
      data.platformVersions.versions
        .find((version) => version.channel === 'linkedin')
        ?.body?.find((node) => node.type === 'img')?.photoTags
    ).toEqual([])
    const scheduled = await apiRequest(page, `/api/v1/content-drafts/${id}/schedule`, {
      method: 'POST',
      body: {
        channelConnectionIds: [workspace.channels.linkedin],
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        version: data.version,
      },
    })
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201)
    await app.reload()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(
      page
        .getByTestId('preview-panel')
        .getByAltText('Shared description from the independent LinkedIn version.')
    ).toBeVisible()
    expect(errors).toEqual([])
  }
)

test(
  'TF-040: a controlled metadata URL becomes a stored image and scheduled attachment',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    test.skip(
      !process.env.E2E_LINK_FIXTURE_HOST,
      'Set E2E_LINK_FIXTURE_HOST and include it in the web server SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS.'
    )
    const bytes = await sharp({
      create: { width: 120, height: 60, channels: 4, background: '#39bd7a' },
    })
      .png()
      .toBuffer()
    const source = await startHttpMockServer((request) =>
      request.url === '/page'
        ? {
            rawBody:
              '<html><head><meta property="og:title" content="Controlled image source"><meta property="og:image" content="/image.png"></head></html>',
            headers: { 'content-type': 'text/html' },
          }
        : request.url === '/image.png'
          ? { rawBody: bytes, headers: { 'content-type': 'image/png' } }
          : { status: 404 }
    )
    try {
      await startWorkspace({ channels: ['x'] })
      const id = await openNewDraft(page)
      await draftEditor(page).click()
      await page.keyboard.type('An image explicitly attached from a metadata page.')
      const url = new URL('/page', source.url)
      url.hostname = process.env.E2E_LINK_FIXTURE_HOST!
      await editorMore(page, 'Image from link')
      await page.getByLabel('Page URL').fill(url.toString())
      await page.getByRole('button', { name: 'Find image', exact: true }).click()
      await expect(page.getByAltText('Controlled image source')).toBeVisible()
      await page.getByRole('button', { name: 'Attach image', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Image from link', exact: true })).toHaveCount(
        0
      )
      await expectSaved(page)
      const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
      const image = (saved.body as { body: Record<string, unknown>[] }).body.find(
        (node) => node.type === 'img'
      )!
      expect(image.assetId).toBeTruthy()
      expect(image.sourceUrl).toBe(url.toString())
      const content = await page.request.get(`/api/v1/assets/${image.assetId}/content`)
      expect(content.ok()).toBe(true)
      const decoded = await sharp(await content.body()).metadata()
      expect([decoded.width, decoded.height, decoded.format]).toEqual([120, 60, 'png'])
      await app.reload()
      await expect(draftEditor(page).locator('figure')).toHaveCount(1)
      await page.getByTestId('schedule-button').click()
      const schedule = page.getByTestId('schedule-dialog')
      await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
      await schedule.getByLabel('Open a new draft after scheduling').uncheck()
      await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
      await expect(page.getByTestId('draft-post')).toHaveCount(1)
      const posts = await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)
      expect(JSON.stringify(posts.body)).toContain('SCHEDULED')
      expect(await scheduledAssets(id, 'x')).toEqual([image.assetId])
      expect(source.calls.filter((call) => call.url === '/image.png').length).toBeGreaterThan(0)
    } finally {
      await source.close()
    }
  }
)

test(
  'TF-066 TF-105: a ten-minute 1080p source uploads and schedules for a verified standard X fixture',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'], verifiedStandardVideo: true })
    const id = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('A ten-minute video with original 1080p bytes.')
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles(
        '../../../server/internal/social/integrations/social/x/testdata/ten-minute-1080p.mp4'
      )
    await expect(draftEditor(page).locator('video')).toHaveCount(1)
    await expectSaved(page)
    const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    const video = (saved.body as { body: Record<string, unknown>[] }).body.find(
      (node) => node.type === 'video'
    )!
    expect(video.assetId).toBeTruthy()
    const bytes = await page.request.get(`/api/v1/assets/${video.assetId}/content`)
    expect(bytes.ok()).toBe(true)
    const original = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        '../../../server/internal/social/integrations/social/x/testdata/ten-minute-1080p.mp4'
      )
    )
    expect(Buffer.compare(await bytes.body(), original)).toBe(0)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect
      .poll(() =>
        page
          .getByTestId('preview-panel')
          .locator('video')
          .evaluate((node) => {
            const video = node as HTMLVideoElement
            return [video.videoWidth, video.videoHeight, Math.round(video.duration)]
          })
      )
      .toEqual([1920, 1080, 600])
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1)
    const posts = await apiRequest(page, `/api/v1/content-drafts/${id}/posts`)
    expect(JSON.stringify(posts.body)).toContain('SCHEDULED')
    expect(await scheduledAssets(id, 'x')).toEqual([video.assetId])
  }
)

test(
  'a video stays visible after attaching it from Library, and the media strip removes it',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'], verifiedStandardVideo: true })
    const id = await openNewDraft(page)
    const strip = page.getByTestId('media-strip')
    await draftEditor(page).click()
    await page.keyboard.type('A video from the Library.')
    await page
      .locator('input[type=file][aria-label="Insert media"]')
      .setInputFiles(
        '../../../server/internal/social/integrations/social/x/testdata/ten-minute-1080p.mp4'
      )
    await expect(strip.getByTestId('media-strip-item')).toHaveCount(1)
    await expectSaved(page)
    const uploaded = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      assetIds: string[]
    }

    // Removing it takes it from the post and the Library keeps it.
    await strip.getByRole('button', { name: 'Remove Video 1', exact: true }).click()
    await expect(strip.getByTestId('media-strip-item')).toHaveCount(0)
    await expect(draftEditor(page).locator('video')).toHaveCount(0)
    await expectSaved(page)
    expect(
      ((await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as { assetIds: string[] })
        .assetIds
    ).toEqual([])

    // The picker shows a frame and details, never the MIME type.
    await strip.getByRole('button', { name: 'Browse library', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Attach from Library' })
    await expect(picker.locator('video')).toHaveCount(1)
    await expect(picker).not.toContainText('video/mp4')
    await expect(picker).toContainText(/\d MB · /)
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()

    // A Library node has no upload marker; it still plays in the editor, also after a reload.
    await strip
      .getByRole('button', { name: /^Attach / })
      .first()
      .click()
    await expect(strip.getByTestId('media-strip-item')).toHaveCount(1)
    await expect(draftEditor(page).locator('video')).toHaveCount(1)
    await expectSaved(page)
    const attached = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      assetIds: string[]
    }
    expect(attached.assetIds).toEqual(uploaded.assetIds)
    await app.reload()
    await expect(draftEditor(page).locator('video')).toHaveCount(1)
    await expect(strip.getByTestId('media-strip-item')).toHaveCount(1)
  }
)

import sharp from 'sharp'
import {
  addBatchRows,
  apiRequest,
  draftEditor,
  editorMore,
  expect,
  expectSaved,
  openNewBatch,
  saveBatchDrafts,
  test,
} from './framework'
import { importedBody } from '@/lib/write/import-text'

test.use({ actionTimeout: 30_000 })

test(
  'a framed workspace export returns to its draft for explicit attachment',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    const png = await sharp({
      create: { width: 640, height: 360, channels: 3, background: '#e5eef8' },
    })
      .png()
      .toBuffer()
    await addBatchRows(page, 'caption,asset,channels\nFrame handoff,source.png,x', {
      name: 'source.png',
      mimeType: 'image/png',
      buffer: png,
    })
    const [id] = await saveBatchDrafts(page)
    const url = `/publish/${id}`
    const before = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      assetIds: string[]
    }
    await page.goto(url)
    await editorMore(page, 'Manage media')
    const opened = page.context().waitForEvent('page')
    await page.getByRole('link', { name: 'Frame in Shots editor', exact: true }).click()
    const editor = await opened
    editor.setDefaultTimeout(30_000)
    editor.on('pageerror', (error) => errors.push(error.message))
    await editor.waitForLoadState('domcontentloaded')
    // Loading the source resets the canvas controls; wait for that handoff to finish.
    await expect
      .poll(() => new URL(editor.url()).searchParams.get('asset'), { timeout: 60_000 })
      .toBeNull()
    await editor.getByRole('button', { name: 'Frame', exact: true }).click()
    await expect(editor.getByRole('button', { name: 'Frame', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await editor.getByRole('button', { name: 'Browser frame', exact: true }).click()
    await editor.getByRole('button', { name: 'Apply browser frame', exact: true }).click()
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByRole('button', { name: 'PNG', exact: true }).click()
    await editor.getByRole('button', { name: 'Save to workspace', exact: true }).click()
    const review = editor.getByRole('link', { name: 'Review export in draft', exact: true })
    await expect(review).toBeVisible({ timeout: 90_000 })
    const destination = (await review.getAttribute('href'))!
    const assetId = new URL(destination, 'http://localhost').searchParams.get('attach')!
    expect(assetId).not.toBe(before.assetIds[0])
    // Exporting has not altered the draft or replaced its original upload.
    expect(
      ((await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as { assetIds: string[] })
        .assetIds
    ).toEqual(before.assetIds)
    await review.click()
    await expect(editor.getByAltText('Framed export', { exact: true })).toBeVisible()
    await editor.getByRole('button', { name: 'Attach framed export', exact: true }).click()
    await expect(editor.getByTestId('media-strip-item')).toHaveCount(2)
    await expectSaved(editor)
    await editor.reload()
    const after = (await apiRequest(editor, `/api/v1/content-drafts/${id}`)).body as {
      assetIds: string[]
    }
    expect(after.assetIds).toEqual(expect.arrayContaining([...before.assetIds, assetId]))
    const bytes = await editor.request.get(`/api/v1/assets/${assetId}/content`)
    expect(bytes.status()).toBe(200)
    const metadata = await sharp(await bytes.body()).metadata()
    expect(metadata.width).toBeGreaterThan(640)
    await editor.screenshot({ path: '.context/shots/typefully-frame-handoff.png' })
    expect(errors).toEqual([])
    await editor.close()
  }
)

test(
  'dragging a thread post preserves its contents and ordering after refresh',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        title: 'Thread order',
        plainText: 'First\nSecond\nThird',
        body: importedBody(['First', 'Second', 'Third']),
        channelConnectionIds: [workspace.channels.x],
      },
    })
    expect(created.status).toBe(201)
    await page.setViewportSize({ width: 1600, height: 1000 })
    await app.open(`/publish/${(created.body as { id: string }).id}`)
    await page.getByRole('button', { name: 'Draft details', exact: true }).click()
    const resize = page.getByRole('separator', { name: 'Resize sidebar' })
    const initialWidth = Number(await resize.getAttribute('aria-valuenow'))
    await resize.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(resize).toHaveAttribute('aria-valuenow', String(initialWidth + 64))
    // The wider sidebar reflows the page and a scrollbar can shift the handle
    // a moment later; measure it only once it has stopped moving.
    await expect
      .poll(async () => {
        const before = JSON.stringify(await resize.boundingBox())
        // eslint-disable-next-line no-restricted-syntax -- Two measurements a moment apart prove the handle stopped moving.
        await page.waitForTimeout(200)
        return before === JSON.stringify(await resize.boundingBox())
      })
      .toBe(true)
    const handle = await resize.boundingBox()
    expect(handle).not.toBeNull()
    await page.mouse.move(handle!.x + 2, handle!.y + 80)
    await page.mouse.down()
    await page.mouse.move(handle!.x - 78, handle!.y + 80, { steps: 5 })
    await page.mouse.up()
    await expect(resize).toHaveAttribute('aria-valuenow', String(initialWidth + 144))
    await page
      .getByRole('img', { name: 'Drag post 1', exact: true })
      .dragTo(page.locator('[data-post-number="3"]'))
    await expect(draftEditor(page)).toContainText(/Second[\s\S]*Third[\s\S]*First/)
    await expectSaved(page)
    await app.reload()
    await expect(draftEditor(page)).toContainText(/Second[\s\S]*Third[\s\S]*First/)
  }
)

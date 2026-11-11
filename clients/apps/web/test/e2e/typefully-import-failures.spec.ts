import { addBatchRows, apiRequest, expect, openNewBatch, saveBatchDrafts, test } from './framework'

test(
  'a bulk batch keeps refused rows, recovers a refused draft and a lost response after reload',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    const items = await addBatchRows(
      page,
      'caption,asset,channels\nRefused first,,x\nNot a channel,,myspace\nMissing file,gone.png,x'
    )
    await expect(items).toHaveCount(1)
    // Rows with problems are not added and stay listed with what to fix.
    const preview = page.getByTestId('import-preview')
    await expect(preview).toContainText('Unknown channel myspace')
    await expect(preview).toContainText('no selected file is named gone.png')
    await expect(preview.getByRole('button', { name: /^Add 0 ready rows/ })).toBeDisabled()

    const requests: Record<string, unknown>[] = []
    let refuse = true
    let loseResponse = false
    let acceptedId = ''
    await page.route('**/api/v1/content-batches/*/items/*/draft', async (route) => {
      requests.push(route.request().postDataJSON())
      if (refuse) {
        refuse = false
        return route.fulfill({ status: 422, json: { message: 'Review the rejected caption.' } })
      }
      if (loseResponse) {
        loseResponse = false
        const response = await route.fetch()
        expect(response.ok()).toBe(true)
        acceptedId = (await response.json()).draftId
        return route.abort('failed')
      }
      return route.continue()
    })
    await page.getByRole('button', { name: 'Save ready items as drafts', exact: true }).click()
    await expect(page.getByText('Review the rejected caption.')).toBeVisible()
    await expect(items.first().getByText('Not saved', { exact: true })).toBeVisible()
    const caption = page.getByLabel('Caption for item 1', { exact: true })
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.ok()
    )
    await caption.fill('Corrected draft')
    await caption.blur()
    await saved
    const [first] = await saveBatchDrafts(page)
    expect(requests).toHaveLength(2)
    expect(requests[1].plainText).toBe('Corrected draft')

    await addBatchRows(page, 'caption,asset,channels\nResponse lost,,x')
    loseResponse = true
    await page.getByRole('button', { name: 'Save ready items as drafts', exact: true }).click()
    await expect.poll(() => acceptedId).not.toBe('')
    await expect(items.nth(1).getByText('Not saved', { exact: true })).toBeVisible()
    // A retry returns the draft the lost response created, never a second one.
    expect(await saveBatchDrafts(page)).toEqual([first, acceptedId])
    await app.reload()
    expect(
      await items
        .getByRole('link', { name: /^Open draft/ })
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')))
    ).toEqual([`/publish/${first}`, `/publish/${acceptedId}`])
    await expect(
      page.getByRole('button', { name: 'Save ready items as drafts', exact: true })
    ).toHaveCount(0)
    const persisted = await apiRequest(page, `/api/v1/content-drafts/${acceptedId}`)
    expect((persisted.body as { plainText: string }).plainText).toBe('Response lost')
    const corrected = await apiRequest(page, `/api/v1/content-drafts/${first}`)
    expect((corrected.body as { plainText: string }).plainText).toBe('Corrected draft')
  }
)

test(
  'an upload cut short by a reload asks for its file again instead of claiming it finished',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await openNewBatch(page, app)
    const file = {
      name: 'cut.png',
      mimeType: 'image/png',
      // A 1×1 PNG.
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      ),
    }
    // Hold the storage PUT open so the page closes mid-upload.
    await page.route('**/*', (route) =>
      route.request().method() === 'PUT' ? undefined : route.fallback()
    )
    const reserved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.ok()
    )
    const uploading = page.waitForRequest((request) => request.method() === 'PUT')
    await page.getByLabel('Batch media files').setInputFiles(file)
    await page.getByLabel('Batch CSV', { exact: true }).fill('caption,asset\nCut short,cut.png')
    await page.getByRole('button', { name: 'Preview import', exact: true }).click()
    await page.getByRole('button', { name: /^Add 1 ready rows/ }).click()
    await reserved
    await uploading
    // After the reload the page tries to finish the upload and finds no bytes.
    const refused = page.waitForResponse((response) =>
      response.url().includes('asset.completeUpload')
    )
    await app.reload()
    await refused
    await page.unrouteAll({ behavior: 'ignoreErrors' })

    const item = page.getByTestId('batch-item')
    await expect(
      page.getByRole('status').filter({ hasText: 'did not finish uploading' })
    ).toContainText('cut.png')
    await expect(item).toContainText('Waiting for its file to be selected again')
    await expect(
      page.getByRole('button', { name: 'Save ready items as drafts', exact: true })
    ).toHaveCount(0)
    await page.getByLabel('Select the files again').setInputFiles(file)
    await expect(item).toContainText('PNG · 1×1', { timeout: 60_000 })
    const [id] = await saveBatchDrafts(page)
    const draft = await apiRequest(page, `/api/v1/content-drafts/${id}`)
    expect((draft.body as { assetIds: string[] }).assetIds).toHaveLength(1)
  }
)

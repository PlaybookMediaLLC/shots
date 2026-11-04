import { readFileSync } from 'node:fs'
import { draftEditor, expect, expectSaved, settleSelection, test } from './framework'

test(
  'article metadata, rich text and embeds persist; prepared DMs remain off',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await app.open('/publish')
    await page.getByRole('button', { name: 'New draft of another kind' }).first().click()
    await page.getByRole('menuitem', { name: 'X Article', exact: true }).click()
    await page.waitForURL(/\/publish\/[a-z0-9]+/)
    // Quick compose owns focus until it hands buffered text to the live editor.
    await expect(page.getByRole('dialog', { name: 'New draft', exact: true })).toHaveCount(0)
    await page.getByLabel('Article title', { exact: true }).fill('An article with structure')
    await expect(page.getByLabel('Article title', { exact: true })).toHaveValue(
      'An article with structure'
    )
    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+End')
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+b')
    await settleSelection(page)
    await page.keyboard.type('Bold article opening')
    await expect(editor.locator('strong')).toContainText('Bold article opening')
    await page.keyboard.press('ControlOrMeta+b')
    await settleSelection(page)
    await page.keyboard.press('Enter')
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+i')
    await settleSelection(page)
    await page.keyboard.type('Italic article paragraph')
    await expect(editor.locator('em')).toContainText('Italic article paragraph')
    await page.keyboard.press('ControlOrMeta+i')
    await page.getByLabel('X post to embed').fill('https://x.com/example/status/123456789')
    await page.getByRole('button', { name: 'Embed post', exact: true }).click()
    await expectSaved(page)
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    const preview = page.getByTestId('article-preview')
    await expect(preview).toContainText('An article with structure')
    await expect(preview.locator('strong')).toContainText('Bold article opening')
    await expect(preview.locator('em')).toContainText('Italic article paragraph')
    await expect(preview.locator('[data-x-post="123456789"]')).toBeVisible()
    await app.reload()
    await expect(page.getByLabel('Article title', { exact: true })).toHaveValue(
      'An article with structure'
    )
    await page.getByRole('button', { name: 'Auto-DM settings', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Delivery is off')
    await dialog
      .getByRole('textbox', { name: 'Direct message', exact: true })
      .fill('Hello {{first_name}}, here is the guide.')
    await dialog.getByRole('button', { name: 'Save prepared settings' }).click()
    await expectSaved(page)
    await app.reload()
    await page.getByRole('button', { name: 'Auto-DM settings · prepared', exact: true }).click()
    await expect(
      page.getByRole('dialog').getByRole('textbox', { name: 'Direct message', exact: true })
    ).toHaveValue('Hello {{first_name}}, here is the guide.')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByTestId('publish-button').click()
    await expect(page.getByRole('dialog')).toContainText(
      'Reconnect X to check this account’s Articles access.'
    )
    const review = page.getByTestId('publish-review')
    await review.getByText('More options', { exact: true }).click()
    await review.getByRole('button', { name: 'Auto-DM settings · prepared', exact: true }).click()
    const prepared = page.getByRole('dialog', { name: 'Prepare Auto-DM campaign', exact: true })
    await expect(prepared).toContainText('Delivery is off')
    await prepared
      .getByRole('textbox', { name: 'Direct message', exact: true })
      .fill('Saved from publish review for {{first_name}}')
    await prepared.getByRole('button', { name: 'Save prepared settings', exact: true }).click()
    await expectSaved(page)
    await app.reload()
    await page.getByRole('button', { name: 'Auto-DM settings · prepared', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Direct message', exact: true })).toHaveValue(
      'Saved from publish review for {{first_name}}'
    )
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByTestId('publish-button').click()
    await page.screenshot({ path: '.context/shots/typefully-article-gated.png', fullPage: true })
  }
)

test(
  'a dropped video uploads, survives reload and plays in the post preview',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await app.open('/publish')
    await page.getByTestId('new-draft').first().click()
    await page.waitForURL(/\/publish\/[a-z0-9]+/)
    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)
    await page.keyboard.type('A video attachment')
    const bytes = [
      ...readFileSync('../../../server/internal/social/integrations/social/x/testdata/sample.mp4'),
    ]
    const transfer = await page.evaluateHandle((data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(data)], 'sample.mp4', { type: 'video/mp4' }))
      return transfer
    }, bytes)
    await editor.dispatchEvent('dragenter', { dataTransfer: transfer })
    await editor.dispatchEvent('dragover', { dataTransfer: transfer })
    await editor.dispatchEvent('drop', { dataTransfer: transfer })
    await expect(editor.locator('video')).toBeVisible({ timeout: 60_000 })
    await expectSaved(page)
    await app.reload()
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    const video = page.getByTestId('preview-panel').getByLabel('Attached video', { exact: true })
    await expect(video).toBeVisible()
    await expect(video).toHaveAttribute('src', /\/api\/v1\/assets\/[a-z0-9-]+\/content/)
    await video.evaluate(async (element) => {
      await (element as HTMLVideoElement).play()
    })
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2)
    await page.screenshot({ path: '.context/shots/typefully-video.png', fullPage: true })
  }
)

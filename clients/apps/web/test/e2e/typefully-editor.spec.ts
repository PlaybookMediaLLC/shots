import {
  caretAtDocumentEnd,
  draftEditor,
  expect,
  expectSaved,
  settleSelection,
  test,
} from './framework'

test(
  'emoji preserves the caret and rich pasted text becomes a persisted, undoable thread',
  { tag: '@journey' },
  async ({ app, context, page, startWorkspace }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await startWorkspace({ channels: ['x'] })
    await app.open('/publish')
    await page.getByTestId('new-draft').first().click()
    await page.waitForURL(/\/publish\/[a-z0-9]+/)
    const editor = draftEditor(page)
    await expect(editor).toBeVisible()
    await editor.click()
    await settleSelection(page)
    await page.keyboard.type('Before after')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
    await settleSelection(page)
    await page.getByRole('button', { name: 'Emoji', exact: true }).click()
    const search = page.getByRole('combobox', { name: 'Search emoji' })
    await expect(search).toBeFocused()
    await search.fill(':rocket')
    await search.press('Enter')
    await expect(editor).toContainText('Before 🚀after')
    await settleSelection(page)
    await caretAtDocumentEnd(page)
    await settleSelection(page)
    await page.keyboard.type(' :rocket')
    await page.getByText('Rocket', { exact: true }).click()
    await expect(editor).toContainText('Before 🚀after 🚀')

    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.evaluate(async () => {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob(
            [
              '<p><b>Bold words</b> and <i>italic words</i>.</p><p>Paragraph two keeps its <a href="https://example.com/source">source link</a>.</p><ul><li>First bullet</li><li>Second bullet</li></ul><p>' +
                'More words for splitting. '.repeat(12) +
                '</p>',
            ],
            { type: 'text/html' }
          ),
        }),
      ])
    })
    await caretAtDocumentEnd(page)
    await page.keyboard.press('Enter')
    await page.keyboard.press('ControlOrMeta+V')
    await expect(editor.locator('strong')).toContainText('Bold words')
    await expect(editor.locator('em')).toContainText('italic words')
    await expect(editor).toContainText('Second bullet')
    await expectSaved(page)
    await page.getByLabel('Characters per post').fill('140')
    await page.getByRole('button', { name: 'Make thread', exact: true }).click()
    await expect(
      page.getByText('Thread created. Review the preview before scheduling.')
    ).toBeVisible()
    const count = await page.getByTestId('post-header').count()
    expect(count).toBeGreaterThan(1)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByTestId('post-header')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.getByTestId('post-header')).toHaveCount(count)
    await expect(editor).toContainText('source link')
    await expect(editor.locator('strong')).toContainText('Bold words')
    await expectSaved(page)
    await app.reload()
    await expect(page.getByTestId('post-header')).toHaveCount(count)
    await expect(page.getByLabel('Characters per post')).toHaveValue('140')
    await expect(editor).toContainText('Before 🚀after 🚀')
    await expect(editor.locator('strong')).toContainText('Bold words')
    await page.getByLabel('Split automatically on paste').check()
    await editor.click()
    await settleSelection(page)
    await caretAtDocumentEnd(page)
    await page.keyboard.press('Enter')
    await settleSelection(page)
    await page.evaluate(() =>
      navigator.clipboard.writeText('Automatic splitting keeps the rest of the draft. '.repeat(10))
    )
    await page.keyboard.press('ControlOrMeta+V')
    await expect.poll(() => page.getByTestId('post-header').count()).toBeGreaterThan(count)
    await expect(editor).toContainText('Automatic splitting keeps the rest of the draft.')
    await expectSaved(page)
    await app.reload()
    await expect(page.getByLabel('Split automatically on paste')).toBeChecked()
    await page.screenshot({ path: '.context/shots/typefully-editor.png', fullPage: true })
    expect(errors).toEqual([])
  }
)

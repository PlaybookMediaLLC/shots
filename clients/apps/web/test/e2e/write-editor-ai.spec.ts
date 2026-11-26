import {
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  type Page,
  settleSelection,
  test,
} from './framework'

const prompt = (page: Page) => page.getByPlaceholder('Ask AI anything...')

async function start(page: Page, text: string) {
  await openNewDraft(page)
  const editor = draftEditor(page)
  await editor.click()
  await settleSelection(page)
  await page.keyboard.type(text)
  return editor
}

test(
  'the editor AI menu writes into the post, and the writer keeps or discards it',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const editor = await start(page, 'We shipped faster exports')

    await page.keyboard.press('ControlOrMeta+j')
    await prompt(page).fill('Write a closing line')
    await page.keyboard.press('Enter')
    await expect(editor).toContainText('Scripted editor draft.', { timeout: 60_000 })
    await page.getByRole('option', { name: 'Discard' }).click()
    await expect(editor).not.toContainText('Scripted editor draft.')
    await expect(editor).toContainText('We shipped faster exports')

    await page.getByRole('button', { exact: true, name: 'Ask AI' }).click()
    await prompt(page).fill('Write a closing line')
    await page.keyboard.press('Enter')
    await expect(editor).toContainText('Scripted editor draft.', { timeout: 60_000 })
    await page.getByRole('option', { name: 'Accept' }).click()
    await expectSaved(page)
    await page.reload()
    await expect(draftEditor(page)).toContainText('Scripted editor draft.')
  }
)

test(
  'a space on an empty line opens the menu, and a review comments on the passage it quotes',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const editor = await start(page, 'We shipped faster exports today')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')
    await expect(prompt(page)).toBeVisible()
    await page.getByRole('option', { name: 'Review and comment' }).click()
    await expect(page.getByText('The review added 1 comment.')).toBeVisible({ timeout: 60_000 })
    await expect(
      editor.locator('.slate-comment').filter({ hasText: 'We shipped faster' })
    ).toBeVisible()
    await expectSaved(page)
    await page.getByRole('button', { exact: true, name: 'Comments' }).click()
    await expect(page.getByTestId('comments-panel')).toContainText(
      'AI review: Open with the result.'
    )
  }
)

test(
  'a refused AI request says why and leaves the post as it was',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const editor = await start(page, 'We shipped faster exports')
    await page.route('**/api/ai/document?**', (route) =>
      route.fulfill({ json: { error: 'Too many AI requests.' }, status: 429 })
    )
    await page.keyboard.press('ControlOrMeta+j')
    await prompt(page).fill('Write a closing line')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Too many AI requests.')).toBeVisible()
    await expect(editor).toContainText('We shipped faster exports')
  }
)

test(
  'typing offers an inline suggestion that Tab accepts',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    const editor = await start(page, 'We will ship it ')
    await expect(editor).toContainText('and measure the result.', { timeout: 60_000 })
    await page.keyboard.press('Tab')
    await expectSaved(page)
    await page.reload()
    await expect(draftEditor(page)).toContainText('We will ship it and measure the result.')
  }
)

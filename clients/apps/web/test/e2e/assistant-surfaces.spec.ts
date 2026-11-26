import { canvasDocumentSchema } from '@/lib/canvas/document'
import { blankArtboard } from '@/lib/canvas/recipes'
import { newCreativeSetId } from '@/lib/creative-sets/document'
import {
  draftEditor,
  expect,
  openNewDraft,
  type Page,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

/** The assistant on the editing surfaces, against the scripted model. */

async function ask(page: Page, words: string) {
  const assistant = page.getByRole('region', { name: 'Assistant' })
  const box = assistant.getByRole('textbox', { name: 'Ask the assistant' })
  await box.fill(words)
  await box.press('Enter')
  return assistant
}

async function dropScreenshot(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0f172a'
    context.fillRect(0, 0, 1200, 800)
    context.fillStyle = '#f8fafc'
    context.font = '48px sans-serif'
    context.fillText('ada@example.com', 80, 120)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((png) => resolve(png!)))
    const data = new DataTransfer()
    data.items.add(new File([blob], 'app.png', { type: 'image/png' }))
    document
      .querySelector('[data-local-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('img[alt="Main image"]')).toHaveCount(1)
}

test(
  'a design review applies from its card, and redaction opens its review once',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await dropScreenshot(page)
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()

    const assistant = await ask(page, 'Review this design')
    await assistant.getByRole('button', { exact: true, name: 'Apply' }).click({ timeout: 60_000 })
    await expect(assistant.getByRole('button', { name: 'Applied' })).toBeDisabled()
    // The card keeps its state while the panel is hidden.
    await assistant.getByRole('button', { name: 'Hide the assistant' }).click()
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()
    await expect(assistant.getByRole('button', { name: 'Applied' })).toBeDisabled()

    // The reply streams before the run ends; a message sent meanwhile is not taken.
    await expect(assistant.getByRole('button', { name: 'Stop' })).toHaveCount(0, {
      timeout: 60_000,
    })
    await ask(page, 'Redact the personal details')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await assistant.getByRole('button', { name: 'Hide the assistant' }).click()
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()
    await expect(assistant.getByRole('button', { name: 'Scan & review' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  }
)

test(
  'the Store assistant edits slides in one undoable change, and the chat can be reopened',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/create/store')
    await page.getByRole('button', { name: 'Use the sample set' }).click()
    await expect(page.locator('[data-store-canvas-slide]')).toBeVisible()
    await page.getByRole('button', { name: 'Open the assistant', exact: true }).click()
    const slides = page.getByRole('listbox', { name: 'Slides' }).getByRole('option')
    const before = await slides.count()

    const saved = page.waitForResponse((response) =>
      response.url().includes('assistantThread.save')
    )
    const assistant = await ask(page, 'Duplicate the open slide')
    await expect(assistant.getByText('Duplicated the slide.')).toBeVisible({ timeout: 60_000 })
    await expect(slides).toHaveCount(before + 1)
    expect((await saved).ok()).toBe(true)
    await assistant.getByRole('button', { name: 'Undo' }).click()
    await expect(slides).toHaveCount(before)

    await assistant.getByRole('button', { name: 'New chat' }).click()
    await expect(assistant.getByText('Duplicated the slide.')).toHaveCount(0)
    await assistant.getByRole('button', { name: 'Saved chats' }).click()
    await page.getByRole('menuitem', { name: 'Duplicate the open slide' }).click()
    await expect(assistant.getByText('Duplicated the slide.')).toBeVisible()
  }
)

/** The assistant, opened from the sidebar unless the page already shows it. */
async function openAssistantOn(page: Page) {
  const assistant = page.getByRole('region', { name: 'Assistant' })
  const box = assistant.getByRole('textbox', { name: 'Ask the assistant' })
  const launcher = page.getByRole('button', { name: 'Open the assistant', exact: true })
  await expect(launcher).toBeVisible({ timeout: 60_000 })
  if (!(await box.isVisible())) await launcher.click()
  await expect(box).toBeVisible()
}

/** Ask, then wait for the whole run: the reply streams before the run ends. */
async function askAndFinish(page: Page, words: string, reply: string) {
  const assistant = await ask(page, words)
  await expect(assistant.getByText(reply)).toBeVisible({ timeout: 90_000 })
  await expect(assistant.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  return assistant
}

test(
  'the Canvas assistant renames an artboard on the board, and Undo takes it back',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/home')
    const created = await trpcMutation(page, 'canvas.create', {
      document: canvasDocumentSchema.parse({
        artboards: [blankArtboard('wide-16x9', { x: 0, y: 0 })],
        kind: 'canvas',
        version: 1,
      }),
      id: newCreativeSetId(),
      name: 'Board assistant',
    })
    expect(created.status).toBe(200)
    const canvasId = (created.body as { id: string }).id
    const firstName = async () =>
      (
        (await trpcQuery(page, 'canvas.get', { canvasId })).body as {
          document: { artboards: { name: string }[] }
        }
      ).document.artboards[0]!.name
    const before = await firstName()
    await app.open(`/canvas/${canvasId}`)
    await openAssistantOn(page)
    const assistant = await askAndFinish(page, 'Rename the first artboard', 'Renamed the artboard.')
    await expect.poll(firstName, { timeout: 30_000 }).toBe('Assistant hero')
    await assistant.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(firstName, { timeout: 30_000 }).toBe(before)
  }
)

test(
  'the Story Set assistant rewrites a headline and saves it',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/creative-sets')
    await page.getByRole('button', { name: 'New Story Set' }).click()
    await page.getByLabel('Story Set name').fill('Assistant set')
    await page.getByLabel('Story headline', { exact: true }).fill('Before the assistant')
    await page
      .getByLabel('Product screenshot', { exact: true })
      .setInputFiles('public/demo/notion-showcase.webp')
    await page.getByRole('button', { name: 'Create three formats' }).click({ timeout: 45_000 })
    await expect(page).toHaveURL(/\/creative-sets\/c[a-z0-9]+$/, { timeout: 120_000 })
    await expect(page.getByTestId('set-save-status')).toContainText('Saved', { timeout: 45_000 })
    await openAssistantOn(page)
    await askAndFinish(page, 'Rewrite the first story headline', 'Rewrote the headline.')
    await expect(page.getByLabel('Story headline', { exact: true })).toHaveValue(
      'Assistant headline'
    )
  }
)

test(
  'Code Studio and the tweet editor take an assistant edit',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/create/code')
    await expect(page.getByRole('textbox', { name: 'Code editor' })).toBeVisible({
      timeout: 60_000,
    })
    await openAssistantOn(page)
    let assistant = await askAndFinish(page, 'Caption the first slide', 'Captioned the slide.')
    await expect(assistant.getByRole('button', { name: 'Undo' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Caption', exact: true })).toHaveValue(
      'Assistant caption'
    )

    await app.open('/create/tweet')
    await openAssistantOn(page)
    assistant = await askAndFinish(page, 'Make the card dark', 'Made the card dark.')
    await assistant.getByRole('button', { name: 'Undo' }).click()
    await expect(assistant.getByText('Undone')).toBeVisible()
  }
)

test(
  'the post composer changes only when the writer accepts the offered text',
  { tag: '@journey' },
  async ({ page }) => {
    await openNewDraft(page, { title: 'Assistant draft' })
    await openAssistantOn(page)
    const assistant = await askAndFinish(page, 'Offer a closing post', 'Offered a closing post.')
    await expect(draftEditor(page)).not.toContainText('Try it and tell us what you think.')
    await assistant.getByRole('button', { name: 'Accept' }).click()
    await expect(draftEditor(page)).toContainText('Try it and tell us what you think.')
  }
)

test(
  'a selected layer offers Ask AI, a saved preset applies, and a saved chat can be deleted',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    const preset = await trpcMutation(page, 'creativeTemplate.create', {
      definition: { document: { image: { src: null }, version: 2 }, kind: 'design-preset' },
      name: 'Launch',
    })
    expect(preset.status).toBe(200)
    await dropScreenshot(page)
    await page.getByRole('button', { exact: true, name: 'Add Text' }).first().click()
    await page.getByRole('button', { name: 'Ask AI about this layer' }).click()
    const assistant = await askAndFinish(page, 'Apply the launch preset', 'Applied the preset.')
    await expect(assistant.getByText('Applied preset “Launch”')).toBeVisible()

    // The delete queues behind the save, so it can be chosen at once.
    await assistant.getByRole('button', { name: 'Saved chats' }).click()
    await page.getByRole('menuitem', { name: 'Delete this chat' }).click()
    await expect(assistant.getByText('Apply the launch preset')).toHaveCount(0)
    await assistant.getByRole('button', { name: 'Saved chats' }).click()
    await expect(page.getByRole('menuitem', { name: 'No saved chats yet' })).toBeVisible()
  }
)

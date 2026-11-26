import { draftEditor, expect, type Page, test, trpcMutation, trpcQuery } from './framework'
import { canvasDocumentSchema } from '@/lib/canvas/document'
import { blankArtboard } from '@/lib/canvas/recipes'
import { newCreativeSetId } from '@/lib/creative-sets/document'
import sharp from 'sharp'

test.use({ workspaceOptions: { plan: 'pro' } })

/**
 * The AI features run against the deterministic scripted model
 * (PLATFORM_AI_SCRIPTED=1), which exercises wiring, validation, storage, and
 * the UI without a provider. It is not a quality bar for the real models.
 */

async function dropScreenshot(page: Page) {
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 800
    const context = canvas.getContext('2d')!
    context.fillStyle = '#e11d48'
    context.fillRect(0, 0, 1200, 400)
    context.fillStyle = '#f8fafc'
    context.fillRect(0, 400, 1200, 400)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((png) => resolve(png!), 'image/png')
    )
    const data = new DataTransfer()
    data.items.add(new File([blob], 'app.png', { type: 'image/png' }))
    document
      .querySelector('[data-local-dropzone]')!
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
  await expect(page.locator('img[alt="Main image"]')).toHaveCount(1)
}

async function exportCorner(page: Page) {
  await page.getByRole('button', { exact: true, name: 'Export' }).click()
  await page.getByRole('button', { exact: true, name: 'PNG' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export as PNG' }).click()
  const file = await (await download).path()
  await page.keyboard.press('Escape')
  const { data, info } = await sharp(file!).raw().toBuffer({ resolveWithObject: true })
  const offset = (24 * info.width + 24) * info.channels
  return [data[offset]!, data[offset + 1]!, data[offset + 2]!]
}

test(
  'copilot versions compare before applying; captions and alt text are written and kept',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await dropScreenshot(page)
    await page.getByRole('button', { exact: true, name: 'Add Text' }).first().click()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // "Give me four versions" opens four complete versions beside the original in the unified assistant.
    await page.getByRole('button', { name: 'Open the AI copilot' }).click()
    const panel = page.getByRole('region', { name: 'Assistant' })
    await panel.getByLabel('Ask the assistant').fill('Give me four versions of this design')
    await panel.getByLabel('Ask the assistant').press('Enter')
    // The request prefills Variants inline; spending credits still takes an explicit click.
    await panel.getByRole('button', { name: 'Make 4 versions' }).click({ timeout: 60_000 })
    const versions = panel.getByRole('list', { name: 'Versions' })
    await expect(versions.getByRole('button', { name: /^Inspect / })).toHaveCount(4, {
      timeout: 90_000,
    })
    await expect(versions.getByText('Original')).toBeVisible()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // Inspect one, keep the original, then apply another: one undo step back.
    await versions.getByRole('button', { name: 'Inspect Tilted square' }).click()
    const inspect = page.getByRole('dialog', { name: 'Tilted square' })
    await expect(inspect.getByRole('img', { name: 'Tilted square' })).toBeVisible({
      timeout: 60_000,
    })
    await inspect.getByRole('button', { name: 'Keep original' }).click()
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()
    await versions.getByRole('button', { name: 'Inspect Tilted square' }).click()
    await inspect.getByRole('button', { name: 'Apply this version' }).click()
    await expect(page.getByText('1:1', { exact: true }).first()).toBeVisible()
    // Shortcuts are ignored inside dialogs: undo once the inspector has fully closed.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.getByText('4:3', { exact: true }).first()).toBeVisible()

    // Captions: alt text and one caption per platform, editable and kept with the design.
    await panel.getByRole('button', { exact: true, name: 'Captions' }).click()
    await panel
      .getByRole('button', { name: 'Write alt text and captions' })
      .click({ timeout: 60_000 })
    const x = panel.getByLabel('X caption')
    await expect(x).toHaveValue(/Meet/, { timeout: 60_000 })
    await expect(panel.getByLabel('LinkedIn caption')).toHaveValue(/Meet/)
    await expect(panel.getByLabel('Instagram caption')).toHaveValue(/#launch/)
    await x.fill('Meet the new dashboard.')
    await x.blur()
    await panel.getByRole('button', { name: 'Hide the assistant' }).click()
    await page.getByRole('button', { exact: true, name: 'Share' }).click()
    await expect(
      page.getByRole('dialog', { name: 'Share design' }).getByLabel('Alt text')
    ).toHaveValue(/product screenshot/)
    await page.keyboard.press('Escape')
  }
)

test(
  'an AI background in the screenshot palette applies as an image background and exports',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.openEditor()
    await dropScreenshot(page)
    const before = await exportCorner(page)

    await page.getByRole('button', { exact: true, name: 'BG' }).click()
    await page.getByRole('button', { name: 'AI background' }).click()
    await page.getByLabel('Describe the background').fill('Warm glow behind the product')
    await page.getByRole('radio', { name: 'From screenshot' }).click()
    await expect(page.getByLabel('Palette').locator('span')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Generate background' }).click()
    const results = page.getByRole('list', { name: 'Generated backgrounds' })
    await expect(results.getByRole('button')).toHaveCount(1, { timeout: 90_000 })
    const after = await exportCorner(page)
    expect(after).not.toEqual(before)

    // Regenerating keeps the earlier result to go back to.
    await page.getByRole('button', { name: 'Generate another' }).click()
    await expect(results.getByRole('button')).toHaveCount(2, { timeout: 90_000 })
  }
)

test(
  'the assistant bar answers from the page it is on, offers the work it found, and hands the canvas to its copilot',
  { tag: '@journey' },
  async ({ app, page }) => {
    const created = await trpcMutation(page, 'project.create', {
      name: 'Assistant launch hero',
      document: { version: 2, image: { src: null } },
    })
    expect(created.status).toBe(200)
    const projectId = (created.body as { id: string }).id

    await app.open('/home')
    await page.getByRole('button', { name: 'Open the assistant', exact: true }).click()
    const assistant = page.getByRole('region', { name: 'Assistant' })
    await expect(assistant.getByTitle('The assistant sees: Home')).toBeVisible()
    // An empty bar offers one-click asks; asking to make something offers a button that starts it.
    await assistant.getByRole('button', { name: 'Start a product launch canvas' }).click()
    await expect(
      assistant.getByRole('link', { name: /Start a Product launch canvas/ })
    ).toHaveAttribute('href', '/canvas/new?recipe=product-launch')
    await expect(assistant.getByRole('group', { name: 'Suggestions' })).toHaveCount(0)
    await assistant.getByRole('button', { name: 'New chat' }).click()
    await expect(assistant.getByRole('group', { name: 'Suggestions' })).toBeVisible()

    const sent = page.waitForRequest('**/api/ai/assistant')
    await assistant.getByRole('textbox', { name: 'Ask the assistant' }).fill('What did I work on?')
    await page.keyboard.press('Enter')
    // The page went with the question; the scripted model answers from it.
    expect((await sent).postDataJSON().page).toMatchObject({ area: 'home', path: '/home' })
    await expect(assistant.getByText(/^You are on Home\./)).toBeVisible({ timeout: 60_000 })
    const link = assistant.getByRole('link', { name: /Open Assistant launch hero/ })
    await expect(link).toHaveAttribute('href', `/editor?project=${projectId}`)

    // Hidden, the bar comes back with ⌘J (Ctrl+J), the conversation intact.
    await assistant.getByRole('button', { name: 'Hide the assistant' }).click()
    await expect(assistant).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+j')
    await expect(assistant.getByRole('textbox', { name: 'Ask the assistant' })).toBeFocused()
    await expect(assistant.getByText(/^You are on Home\./)).toBeVisible()

    // Asked to change existing work, it finds it and offers it open with the change ready.
    await assistant.getByRole('button', { name: 'New chat' }).click()
    await assistant
      .getByRole('textbox', { name: 'Ask the assistant' })
      .fill('Change the headline to Launch day')
    await page.keyboard.press('Enter')
    await expect(assistant.getByRole('link', { name: /Edit with AI/ })).toHaveAttribute(
      'href',
      `/editor?project=${projectId}&ask=Change+the+headline+to+Launch+day`,
      { timeout: 60_000 }
    )

    // Asked for a post, it writes one, and one click opens it as a draft in the post editor.
    await assistant.getByRole('button', { name: 'New chat' }).click()
    await assistant.getByRole('button', { name: 'Draft a post about our latest release' }).click()
    await expect(assistant.getByText(/^We just shipped something new\./)).toBeVisible({
      timeout: 60_000,
    })
    await assistant.getByRole('button', { name: 'Open as a draft' }).click()
    await expect(page).toHaveURL(/\/publish\/[^/?]+$/, { timeout: 60_000 })
    await expect(draftEditor(page)).toContainText('We just shipped something new.', {
      timeout: 60_000,
    })

    // On a canvas the artboard copilot answers instead, with the bar open on the board.
    const initial = canvasDocumentSchema.parse({
      version: 1,
      kind: 'canvas',
      artboards: [
        blankArtboard('wide-16x9', { x: 0, y: 0 }),
        blankArtboard('wide-16x9', { x: 2400, y: 0 }),
      ],
    })
    const canvas = await trpcMutation(page, 'canvas.create', {
      id: newCreativeSetId(),
      name: 'Assistant canvas',
      document: initial,
    })
    expect(canvas.status).toBe(200)
    // Opened with a request (an Edit with AI button), the canvas's bar holds it ready to send.
    await app.open(`/canvas/${(canvas.body as { id: string }).id}?ask=Make+the+headline+bold`)
    const board = page.getByRole('region', { name: 'Assistant' })
    await expect(board.getByTitle(/^The assistant sees: Artboard 1 · /)).toBeVisible({
      timeout: 60_000,
    })
    await expect(board.getByRole('textbox', { name: 'Ask the assistant' })).toHaveValue(
      'Make the headline bold'
    )
    await expect.poll(() => new URL(page.url()).searchParams.has('ask')).toBe(false)

    // A request about every artboard runs on each in turn.
    await board
      .getByRole('textbox', { name: 'Ask the assistant' })
      .fill('Make the headline bold on every artboard')
    await page.keyboard.press('Enter')
    await expect(board.getByText('Artboard 2 of 2…')).toBeVisible({ timeout: 90_000 })
    await expect(board.getByText('Done: 2 artboards.')).toBeVisible({ timeout: 90_000 })
    // Each artboard's own design changed and was saved, not the first one's twice.
    const canvasId = (canvas.body as { id: string }).id
    await expect
      .poll(
        async () => {
          const stored = await trpcQuery(page, 'canvas.get', { canvasId })
          const artboards = (stored.body as { document?: { artboards?: { document: unknown }[] } })
            .document?.artboards
          return (artboards ?? []).map(
            (artboard, index) =>
              JSON.stringify(artboard.document) !==
              JSON.stringify(initial.artboards[index]?.document)
          )
        },
        { timeout: 30_000 }
      )
      .toEqual([true, true])
  }
)

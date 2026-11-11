import { draftEditor, expect, expectSaved, openNewDraft, settleSelection, test } from './framework'

/**
 * The post editor brief's acceptance tests: a short, platform-aware slash
 * menu that never leaves junk, one look with the app (Inter, 32px controls,
 * Phosphor icons), a paste split that is previewed first, narrow screens,
 * and popovers that never move the page.
 */

test(
  'the slash menu offers post commands, filters, and dismisses without leaving junk',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await openNewDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)

    // A slash inside a word or a URL is just text.
    await page.keyboard.type('and/or https://x.com/a ')
    await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0)

    await page.keyboard.press('Enter')
    const scroll = () => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)
    const before = await scroll()
    await page.keyboard.type('/')
    const menu = page.getByRole('listbox', { name: 'Commands' })
    await expect(menu).toBeVisible()
    expect(await scroll()).toBe(before)
    const options = menu.getByRole('option')
    const labels = await options.allTextContents()
    expect(labels.length).toBeGreaterThanOrEqual(15)
    expect(labels.length).toBeLessThanOrEqual(24)
    expect(labels.join(' ')).not.toMatch(/Heading|Toggle|Callout|Code block|columns|color/i)
    await expect(options.filter({ hasText: /^Poll/ })).toHaveCount(1)
    // Below the line being typed (above only when there is less room below), never over it.
    const query = page.getByRole('combobox', { name: 'Command' })
    const line = (await query.boundingBox())!
    const box = (await menu.boundingBox())!
    expect(box.y >= line.y + line.height || box.y + box.height <= line.y).toBe(true)

    // One highlight, whether the mouse or the keyboard moved it.
    await options.nth(3).hover()
    await page.keyboard.press('ArrowDown')
    await expect(menu.locator('[data-active-item="true"]')).toHaveCount(1)

    // Typing filters with nothing pinned above the matches.
    await page.keyboard.type('he')
    await expect(options.first()).not.toContainText('Ask AI')
    // No match leaves one row: Ask AI with the query when AI is on, else a note.
    await page.keyboard.type('zzz')
    await expect(menu).toContainText(/^(Ask AI: hezzz|No commands match “hezzz”)$/)

    // Escape keeps what was typed, as text.
    await page.keyboard.press('Escape')
    await expect(editor).toContainText('/hezzz')
    await expect(query).toHaveCount(0)

    // Backspace right after "/" takes the slash away; a space after it types one.
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Backspace')
    await expect(menu).toHaveCount(0)
    await page.keyboard.type('/ plain')
    await expect(editor).toContainText('/ plain')
    await expect(menu).toHaveCount(0)

    // Running a command leaves no "/query" behind.
    await page.keyboard.press('Enter')
    await page.keyboard.type('/split')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expect(editor).not.toContainText('/split')
    await expectSaved(page)
  }
)

test(
  'the editor looks like the app: Inter, one control size, Phosphor icons with labels',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await openNewDraft(page)
    const editor = draftEditor(page)
    await expect(editor).toHaveCSS('font-family', /Inter/)
    await expect(editor).toHaveCSS('font-size', '16px')
    const tools = page.getByRole('toolbar', { name: 'Draft tools' }).getByRole('button')
    expect(await tools.count()).toBeGreaterThanOrEqual(4)
    for (const button of await tools.all()) {
      await expect(button).toHaveCSS('height', '32px')
      await expect(button).toHaveCSS('border-top-left-radius', '6px')
      await expect(button).toHaveAttribute('aria-label', /.+/)
    }
    await tools.first().hover()
    await expect(page.getByRole('tooltip')).toContainText('Add to thread')

    await editor.click()
    await page.keyboard.type('Icons only ')
    await page.keyboard.type('/')
    await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible()
    // Every icon in the editor, its toolbar and its menu is a Phosphor icon; no glyphs.
    const scan = await page.evaluate(() => {
      const roots = [
        ...document.querySelectorAll(
          '[data-testid="draft-editor"], [role="toolbar"][aria-label="Draft tools"], [role="listbox"]'
        ),
      ]
      const boxes = roots.flatMap((root) =>
        [...root.querySelectorAll('svg')].map((svg) => svg.getAttribute('viewBox'))
      )
      const glyphs = roots.flatMap((root) =>
        [...root.querySelectorAll('button, [role="option"], [role="menuitem"]')]
          .map((control) => control.textContent?.trim() ?? '')
          .filter((text) => /^[☺⋯▾▸•✕×]$/.test(text))
      )
      return { boxes, glyphs }
    })
    expect(scan.boxes.length).toBeGreaterThan(0)
    expect(scan.boxes.every((box) => box === '0 0 256 256')).toBe(true)
    expect(scan.glyphs).toEqual([])
  }
)

test(
  'an auto-split paste is previewed first, and narrow screens keep the avatar',
  { tag: '@journey' },
  async ({ context, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })
    await openNewDraft(page)
    const editor = draftEditor(page)
    await page.getByTestId('options-chip').click()
    await page.getByText('Split automatically on paste').click()
    await editor.click()
    await settleSelection(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const paragraph = 'Shots keeps the canvas quiet while you write the thing that matters next. '
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      paragraph.repeat(20).slice(0, 1200)
    )
    await page.keyboard.press('ControlOrMeta+V')
    const preview = page.getByTestId('split-preview')
    await expect(preview.getByRole('heading')).toHaveText('Split into 5 posts?')
    for (const length of await preview.locator('li p:first-child').allTextContents())
      expect(Number(length.match(/(\d+) \/ 280/)?.[1])).toBeLessThanOrEqual(280)
    await preview.getByRole('button', { name: 'Split into 5 posts' }).click()
    await expect(page.getByTestId('post-header')).toHaveCount(5)
    await expectSaved(page)
    // Narrow, the options panel becomes a sheet that hides the page behind it.
    await page.getByTestId('options-chip').click()

    await page.setViewportSize({ width: 584, height: 715 })
    const avatar = page.locator('[data-post-avatar]').first()
    await expect(avatar).toBeVisible()
    const column = (await page.getByTestId('composer-body').boundingBox())!
    expect(Math.round((await avatar.boundingBox())!.x - column.x)).toBe(16)
    await expect(editor).toHaveCSS('padding-right', '16px')
  }
)

test(
  'a slash AI command is reviewed first and one Undo takes it back',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    // The scripted AI model answers here (PLATFORM_AI_SCRIPTED, lib/e2e-hooks.ts).
    await startWorkspace({ channels: ['x'] })
    await openNewDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)
    await page.keyboard.type('we shipped the new editor today')
    await expectSaved(page)
    await page.keyboard.press('Enter')
    await page.keyboard.type('/punch')
    await page.keyboard.press('Enter')
    const review = page.getByTestId('refine-review')
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await review.getByRole('button', { name: 'Accept' }).click()
    await expect(editor).toContainText('(refined)')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).not.toContainText('(refined)')
    await expect(editor).toContainText('we shipped the new editor today')
  }
)

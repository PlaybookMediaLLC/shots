import { apiRequest, db, draftEditor, expect, expectSaved, test } from './framework'

// @dev-server until fixed: on the production build one early-typed title character is lost.
test(
  'early typing, reordered post controls, selected comments, and failed saves preserve text',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await app.open('/write')
    // Hold creation so the first keystrokes necessarily precede the route and collab sync.
    await page.route('**/api/v1/content-drafts', async (route) => {
      if (route.request().method() === 'POST')
        await new Promise((resolve) => setTimeout(resolve, 500))
      await route.continue()
    })
    await page.getByTestId('new-draft').first().click()
    const early = page.getByRole('textbox', { name: 'New draft text' })
    await expect(early).toBeFocused()
    await page.keyboard.type('Hello world from QA')
    await page.waitForURL(/\/write\/[a-z0-9]+/)
    const id = new URL(page.url()).pathname.split('/').pop()!
    const editor = draftEditor(page)
    await expect(early).toBeHidden({ timeout: 60_000 })
    await expect(editor).toContainText('Hello world from QA')
    await expectSaved(page)

    const title = '0123456789'.repeat(20)
    await page.getByRole('textbox', { name: 'Draft title', exact: true }).pressSequentially(title)
    await expect(page.getByRole('textbox', { name: 'Draft title', exact: true })).toHaveValue(title)
    await expectSaved(page)
    expect((await apiRequest(page, `/api/v1/content-drafts/${id}`)).body).toMatchObject({ title })

    await page.getByRole('button', { name: 'Add post', exact: true }).click()
    await editor
      .locator('[data-slate-node="element"]')
      .filter({ has: page.locator('[data-slate-zero-width]') })
      .last()
      .click()
    await page.keyboard.type('Second post with padding')
    await expect(editor).toContainText('Second post with padding')
    await page.getByRole('button', { name: 'Move post 2 up', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Move post 1 up', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Delete post 2', exact: true }).click()
    await expect(editor).not.toContainText('Hello world from QA')
    await expect(editor).toContainText('Second post with padding')

    await editor
      .locator('[data-slate-string]')
      .filter({ hasText: 'padding' })
      .evaluate((element) => {
        const text = element.firstChild!
        const offset = text.textContent!.indexOf('padding')
        const range = document.createRange()
        range.setStart(text, offset)
        range.setEnd(text, offset + 7)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
    await page.keyboard.press('ControlOrMeta+Shift+m')
    await expect(editor.locator('.slate-comment')).toHaveText('padding')
    await page.keyboard.press('Escape')
    await expectSaved(page)

    let attempts = 0
    await page.route(`**/api/v1/content-drafts/${id}`, async (route) => {
      if (route.request().method() === 'PATCH' && ++attempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"message":"Temporary failure"}',
        })
      } else await route.continue()
    })
    await page
      .getByRole('textbox', { name: 'Draft title', exact: true })
      .fill('Retry keeps this title')
    await expect(page.getByTestId('save-state')).toHaveText('Not saved')
    await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible()
    await expectSaved(page)
    expect(attempts).toBeGreaterThanOrEqual(2)
    await app.reload()
    await expect(page.getByRole('textbox', { name: 'Draft title', exact: true })).toHaveValue(
      'Retry keeps this title'
    )
    await expect(editor).toContainText('Second post with padding')

    // Another client replaces the body: the next save keeps this edit until the writer chooses.
    const before = (await apiRequest(page, `/api/v1/content-drafts/${id}`)).body as {
      version: number
    }
    const replaced = await apiRequest(page, `/api/v1/content-drafts/${id}`, {
      method: 'PATCH',
      body: {
        baseVersion: before.version,
        body: [{ type: 'p', children: [{ text: 'Replaced by another client' }] }],
        plainText: 'Replaced by another client',
      },
    })
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200)
    await editor.getByText('Second post with padding').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' and my unsaved words')
    const conflict = page.getByTestId('save-conflict')
    await expect(conflict).toContainText('changed elsewhere')
    await expect(editor).toContainText('Replaced by another client')
    // Review stays blocked until the writer keeps, copies or discards the edit.
    await page.getByTestId('schedule-button').click()
    await expect(page.getByTestId('blocking-problems')).toContainText(
      'conflicts with a newer version'
    )
    await expect(page.getByRole('button', { name: 'Confirm schedule' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await conflict.getByRole('button', { name: 'Discard my edit', exact: true }).click()
    await expect(conflict).toHaveCount(0)
    await app.reload()
    await expect(editor).toContainText('Replaced by another client')
    expect(errors).toEqual([])

    const serverSearches: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.searchParams.has('_rsc') && url.searchParams.has('q')) serverSearches.push(url.href)
    })
    const search = page.getByRole('searchbox', { name: 'Search drafts' }).first()
    await search.fill('<b>&amp;')
    await expect(page.getByText('No drafts match these filters.').first()).toBeVisible()
    await search.fill('Retry keeps')
    await expect(
      page.getByTestId('draft-row').filter({ hasText: 'Retry keeps this title' })
    ).toHaveCount(1)
    expect(serverSearches).toEqual([])
    await search.fill('')
    await expect(page).not.toHaveURL(/[?&]q=/)

    const other = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: { title: 'Bulk companion' },
    })
    expect(other.status).toBe(201)
    await app.reload()
    await page
      .getByRole('button', { name: 'Actions for Retry keeps this title', exact: true })
      .click()
    await page.getByRole('menuitem', { name: /^Select multiple/ }).click()
    await page
      .getByTestId('draft-row')
      .filter({ hasText: 'Bulk companion' })
      .getByRole('link')
      .click()
    const bulk = page.getByRole('toolbar', { name: 'Selected drafts' })
    await expect(bulk).toContainText('2 selected')
    await bulk.getByRole('button', { name: 'Delete', exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete drafts', exact: true })
      .click()
    await expect(page).toHaveURL(/\/write(?:\?|$)/)
    await expect(
      page.getByTestId('draft-row').filter({ hasText: 'Retry keeps this title' })
    ).toHaveCount(0)
    await expect(page.getByTestId('draft-row').filter({ hasText: 'Bulk companion' })).toHaveCount(0)
  }
)

test(
  'New → Post keeps the first words typed, and a retry after a lost answer makes one draft',
  { tag: '@journey' },
  async ({ app, page, workspace }) => {
    await app.open('/home')
    // The first try reaches the server, but its answer is lost on the way back.
    let creations = 0
    await page.route('**/api/v1/content-drafts', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      creations++
      if (creations > 1) return route.continue()
      await route.fetch()
      await route.abort('connectionreset')
    })
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('button', { name: 'New', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Post', exact: true }).click()
    // The menu hands focus back to New as it closes; the box keeps it, so typing lands here.
    const early = page.getByRole('textbox', { name: 'New draft text' })
    await expect(early).toBeFocused()
    await page.keyboard.type('Words typed straight away')
    await page
      .getByRole('dialog', { name: 'New draft' })
      .getByRole('button', { name: 'Retry' })
      .click()
    await page.waitForURL(/\/write\/[a-z0-9]+/)
    await expect(early).toBeHidden({ timeout: 60_000 })
    await expect(draftEditor(page)).toContainText('Words typed straight away')
    await expectSaved(page)
    expect(creations).toBe(2)
    const drafts = await db.rows('SELECT id FROM content_draft WHERE "organizationId" = $1', [
      workspace.id,
    ])
    expect(drafts).toHaveLength(1)
  }
)

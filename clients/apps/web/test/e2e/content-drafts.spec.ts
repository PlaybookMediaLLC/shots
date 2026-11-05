import { readFile } from 'node:fs/promises'
import {
  apiRequest,
  caretAtDocumentEnd,
  chooseChannels,
  createWorkspace,
  db,
  draftEditor,
  expect,
  expectSaved,
  inPreview,
  type Locator,
  openNewDraft,
  openSchedule,
  type Page,
  png,
  previewOf,
  settleSelection,
  test,
  editorMore,
} from './framework'
import JSZip from 'jszip'
import { buildDocx } from './fixtures/docx'

/**
 * Put the caret at the end of a text leaf. slate-react copies the browser
 * selection into the editor on a 100 ms throttle, and toolbar inserts read the
 * editor's, so the helper waits past the throttle before returning.
 */
async function caretAtEndOf(page: Page, word: Locator): Promise<void> {
  const text = (await word.textContent()) ?? ''
  await expect(async () => {
    const box = await word.boundingBox()
    await word.click({ position: { x: (box?.width ?? 1) - 1, y: (box?.height ?? 2) / 2 } })
    expect(
      await page.evaluate(() => {
        const selection = window.getSelection()
        return `${selection?.anchorNode?.textContent}:${selection?.anchorOffset}`
      })
    ).toBe(`${text}:${text.length}`)
  }).toPass({ timeout: 20_000 })
  await settleSelection(page)
}

/** Export from the toolbar's More menu. */
async function exportAs(page: Page, item: 'Export DOCX' | 'Export Markdown'): Promise<void> {
  await editorMore(page, item)
}

/** Click into `target` until the caret is inside it, then type there. */
async function typeInto(page: Page, target: Locator, text: string): Promise<void> {
  await expect(async () => {
    await target.click()
    expect(
      await target.evaluate((element) => {
        const anchor = window.getSelection()?.anchorNode
        return Boolean(anchor && element.contains(anchor))
      })
    ).toBe(true)
  }).toPass({ timeout: 20_000 })
  // Past slate's selection sync, or the first keys land where the caret was.
  await settleSelection(page)
  await page.keyboard.type(text)
  await expect(target).toContainText(text)
}

type PostRow = { caption: string; idempotencyKey: string; platform: string; status: string }

async function draftPosts(draftId: string): Promise<PostRow[]> {
  return await db.rows<PostRow>(
    `SELECT p.caption, p."idempotencyKey", c.platform, p.status::text AS status
       FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
       WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
}

// RFC 013: a hand-written draft, saved, reloaded, checked per channel, and
// scheduled to two channels through the existing scheduler. Posts are queued
// for later, so the social API mock only answers the destination checks.
test(
  'a draft is written, saved, scheduled to two channels once, and one post is cancelled',
  { tag: ['@journey', '@smoke'] },
  async ({ app, browser, identity, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
    const draftId = await openNewDraft(page)

    await page.getByRole('textbox', { name: 'Draft title' }).fill('Launch day')
    await draftEditor(page).click()
    await page.keyboard.type('Launch day is here. ')
    await page.keyboard.press('ControlOrMeta+b')
    await page.keyboard.type('Shots')
    await page.keyboard.press('ControlOrMeta+b')
    await page.keyboard.type(' writes the posts for you.')
    await expect(
      draftEditor(page).locator('strong, [data-slate-leaf] .font-bold').first()
    ).toHaveText('Shots')

    // The image goes to the workspace's storage through the signed upload.
    await page
      .getByLabel('Insert media')
      .and(page.locator('input[type="file"]'))
      .setInputFiles({ buffer: png, mimeType: 'image/png', name: 'launch.png' })
    const image = draftEditor(page).locator('img[src*="/api/v1/assets/"]')
    await expect(image).toBeVisible({ timeout: 30_000 })
    await expectSaved(page)

    await app.reload()
    await expect(draftEditor(page)).toContainText(
      'Launch day is here. Shots writes the posts for you.',
      {
        timeout: 60_000,
      }
    )
    await expect(draftEditor(page).locator('img[src*="/api/v1/assets/"]')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Draft title' })).toHaveValue('Launch day')

    await chooseChannels(page, ['x', 'linkedin'])
    // Bold is dropped on plain-text channels, and the preview says so.
    await inPreview(page, async () => {
      await expect(await previewOf(page, 'x')).toContainText(
        'Launch day is here. Shots writes the posts for you.'
      )
      await expect(page.getByTestId('preview-panel')).toContainText('formatting are removed')
    })

    // Over X's limit: the counter goes red, and scheduling is blocked.
    await caretAtEndOf(page, draftEditor(page).getByText('for you.'))
    await page.keyboard.type(` ${'x'.repeat(260)}`)
    // X is being edited, so its count is in the post's header.
    await expect(page.getByTestId('post-length-1')).toHaveText(/^3\d\d \/ 280$/)
    // Each tab shows only its own limit, and a platform over its limit marks its tab.
    await expect(page.getByTestId('counter-linkedin')).toHaveCount(0)
    await expect(page.getByTestId('platform-over-x')).toBeVisible()
    await expect(page.getByTestId('platform-over-linkedin')).toHaveCount(0)
    // LinkedIn's tab shows LinkedIn's limit, and the X tab keeps its mark there.
    await page.getByTestId('platform-tab-linkedin').click()
    await expect(page.getByTestId('counter-linkedin')).toHaveText(/ \/ 3000$/)
    await expect(page.getByTestId('platform-over-x')).toBeVisible()
    await page.getByTestId('platform-tab-x').click()
    await inPreview(page, async () => {
      await previewOf(page, 'x')
      await expect(page.getByTestId('preview-panel').getByRole('alert')).toContainText(
        'of 280 characters'
      )
    })
    const blocked = await openSchedule(page)
    await expect(blocked.getByTestId('blocking-problems')).toContainText('of 280 characters')
    await expect(blocked.getByRole('button', { name: 'Confirm schedule' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(blocked).toBeHidden()
    await caretAtDocumentEnd(page)

    // Fix it: select what was added and delete it, as the writer would. One
    // Backspace per character took ~100 ms each on a loaded runner, most of
    // the 30 s below.
    await draftEditor(page).evaluate((editor) => {
      const strings = editor.querySelectorAll('[data-slate-string]')
      const text = strings[strings.length - 1]?.firstChild
      const value = text?.textContent ?? ''
      const start = value.search(/ ?x+$/)
      if (!text || start < 0) return
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, value.length)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    await settleSelection(page)
    await page.keyboard.press('Backspace')

    // Count from the counter, so a keystroke the browser dropped under load
    // cannot skew it.
    const counted = async () =>
      Number((await page.getByTestId('post-length-1').textContent())?.split(' / ')[0])
    // The counter trails the keys; a reading taken while it still moves made
    // the loop delete too much. Read it only once it holds still.
    const settledCount = async () => {
      let last = await counted()
      await expect
        .poll(
          async () => {
            const now = await counted()
            const still = now === last
            last = now
            return still
          },
          { intervals: [300] }
        )
        .toBe(true)
      return last
    }
    await expect(async () => {
      const extra = (await settledCount()) - 51
      for (let index = 0; index < extra; index += 1) await page.keyboard.press('Backspace')
      expect(await settledCount()).toBe(51)
    }).toPass({ timeout: 30_000 })
    await expect(page.getByTestId('post-length-1')).toHaveText('51 / 280')
    await expectSaved(page)

    // Dropped formatting is shown in the preview, not a block: nothing stops scheduling.
    const dialog = await openSchedule(page)
    await expect(dialog.getByTestId('blocking-problems')).toHaveCount(0)
    // Stay on this draft to cancel one of its posts below.
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    const submitted = page.waitForRequest(
      (request) =>
        request.method() === 'POST' &&
        new URL(request.url()).pathname === `/api/v1/content-drafts/${draftId}/schedule`
    )
    await dialog.getByRole('button', { name: 'Confirm schedule' }).click()
    const scheduleRequest: unknown = (await submitted).postDataJSON()
    await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 30_000 })
    await expect(page.getByTestId('draft-post').filter({ hasText: 'Scheduled' })).toHaveCount(2)

    const posts = await draftPosts(draftId)
    expect(posts.map(({ caption, platform, status }) => ({ caption, platform, status }))).toEqual([
      {
        caption: 'Launch day is here. Shots writes the posts for you.',
        platform: 'linkedin',
        status: 'SCHEDULED',
      },
      {
        caption: 'Launch day is here. Shots writes the posts for you.',
        platform: 'x',
        status: 'SCHEDULED',
      },
    ])

    // A double submit of the same request replays; it never queues duplicates.
    const replay = await apiRequest(page, `/api/v1/content-drafts/${draftId}/schedule`, {
      body: scheduleRequest,
      method: 'POST',
    })
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body).toMatchObject({ created: false })
    expect(await draftPosts(draftId)).toHaveLength(2)

    // The same version at another time is refused, not answered with the old schedule.
    const version = Number(posts[0].idempotencyKey.split(':v').pop())
    const moved = await apiRequest(page, `/api/v1/content-drafts/${draftId}/schedule`, {
      body: {
        channelConnectionIds: Object.values(workspace.channels),
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        version,
      },
      method: 'POST',
    })
    expect(moved.status, JSON.stringify(moved.body)).toBe(409)
    expect(moved.body).toMatchObject({ code: 'conflict' })
    expect(await draftPosts(draftId)).toHaveLength(2)

    // Another workspace cannot read the draft or its posts.
    const stranger = await browser.newContext()
    try {
      const strangerPage = await stranger.newPage()
      await createWorkspace(
        {
          ...identity,
          email: `other-${identity.email}`,
          workspaceName: `Other ${identity.workspaceName}`,
        },
        strangerPage
      )
      expect((await apiRequest(strangerPage, `/api/v1/content-drafts/${draftId}`)).status).toBe(404)
      expect(
        (await apiRequest(strangerPage, `/api/v1/content-drafts/${draftId}/posts`)).status
      ).toBe(404)
    } finally {
      await stranger.close()
    }

    await page
      .getByTestId('draft-post')
      .filter({ hasText: 'X ·' })
      .getByRole('button', { name: 'Cancel the X post' })
      .click()
    // Cancelling one destination names it and asks first; the others stay queued.
    const cancel = page.getByRole('alertdialog')
    await expect(cancel).toContainText('Cancel the X post?')
    await expect(cancel).toContainText('other destinations stay queued')
    await cancel.getByRole('button', { name: 'Cancel this post', exact: true }).click()
    await expect(page.getByTestId('draft-post').filter({ hasText: 'Cancelled' })).toHaveCount(1)
    expect(
      await db.row(
        `SELECT p.status::text AS status FROM scheduled_post p JOIN channel_connection c
           ON c.id = p."channelConnectionId" WHERE p."contentDraftId" = $1 AND c.platform = 'x'`,
        [draftId]
      )
    ).toEqual({ status: 'CANCELLED' })
  }
)

// Tables, math and footnotes are kept by the editor, survive a reload, and
// each serializes into the channel preview as plain text.
// @dev-server until fixed: on the production build scheduling the table and math blocks posts nothing (1 of 2 runs).
test(
  'a table, a math block and a footnote persist, and the blocks post as images',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['linkedin'] })
    const draftId = await openNewDraft(page)
    await draftEditor(page).click()
    await page.keyboard.type('Pricing')

    // Blocks insert after the block holding the caret.
    await caretAtEndOf(page, draftEditor(page).getByText('Pricing', { exact: true }))
    await editorMore(page, 'Math')
    // The new block opens its equation editor right away, focused.
    await expect(
      draftEditor(page).getByRole('button', { name: 'Add a Tex equation' })
    ).toBeVisible()
    const tex = page.getByPlaceholder(/f\(x\) =/)
    await expect(tex).toBeFocused()
    await tex.fill('E = mc^2')
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(draftEditor(page).locator('.katex').first()).toBeVisible()

    await caretAtEndOf(page, draftEditor(page).getByText('Pricing', { exact: true }))
    await editorMore(page, 'Table')
    const cells = draftEditor(page).locator('td')
    await typeInto(page, cells.nth(0), 'Plan')
    await typeInto(page, cells.nth(1), 'Price')

    // The footnote marker goes at the caret, at the end of the word.
    await caretAtEndOf(page, draftEditor(page).getByText('Pricing', { exact: true }))
    await editorMore(page, 'Footnote')
    await expect(draftEditor(page)).toBeFocused()
    await page.keyboard.type('Prices exclude tax.')
    await expectSaved(page)

    const expectPreview = () =>
      inPreview(page, async () => {
        const preview = await previewOf(page, 'linkedin')
        await expect(preview).toContainText('Pricing[1]')
        // LinkedIn cuts a long post at "…more", as the preview shows; read on.
        const more = preview.getByRole('button', { name: 'more', exact: true })
        if (await more.isVisible()) await more.click()
        await expect(preview).toContainText('[1] Prices exclude tax.')
        await expect(preview).not.toContainText('E = mc^2')
        const panel = page.getByTestId('preview-panel')
        await expect(panel).toContainText('Tables are posted as images.')
        await expect(panel).toContainText('Math blocks are posted as images.')
        await expect(panel).toContainText('Footnotes become numbered notes at the end.')
      })
    await chooseChannels(page, ['linkedin'])
    await expectPreview()
    await expectSaved(page)

    await app.reload()
    await expect(draftEditor(page).locator('table')).toContainText('Plan', { timeout: 60_000 })
    await expect(draftEditor(page).locator('.katex').first()).toBeVisible()
    await expect(draftEditor(page)).toContainText('Prices exclude tax.')
    await expectPreview()

    // Scheduling renders the table and the equation and attaches them.
    const scheduleDialog = await openSchedule(page)
    await scheduleDialog.getByLabel('Open a new draft after scheduling').uncheck()
    await scheduleDialog.getByRole('button', { name: 'Confirm schedule' }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1, { timeout: 30_000 })
    const post = await db.row<{ assetIds: string[]; caption: string }>(
      `SELECT "assetIds", caption FROM scheduled_post WHERE "contentDraftId" = $1`,
      [draftId]
    )
    if (!post) throw new Error('The draft post was not created.')
    expect(post.caption).toBe('Pricing[1]\n\n[1] Prices exclude tax.')
    expect(post.assetIds).toHaveLength(2)
    const assets = await db.rows<{ mediaType: string }>(
      `SELECT "mediaType" FROM asset WHERE id = ANY($1) AND status = 'UPLOADED'`,
      [post.assetIds]
    )
    expect(assets.map(({ mediaType }) => mediaType)).toEqual(['image/png', 'image/png'])
  }
)

// RFC 013 threads: ⌘↵ starts the next post. X gets the first post and the
// rest as replies; LinkedIn gets the thread joined into one post.
test('a thread schedules to X as a post and its replies', async ({ app, page, startWorkspace }) => {
  await startWorkspace({ channels: ['x', 'linkedin'] })
  const draftId = await openNewDraft(page)
  await draftEditor(page).click()
  await page.keyboard.type('First post')
  await settleSelection(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('post-header')).toHaveCount(2)
  await settleSelection(page)
  await page.keyboard.type('Second post')
  await chooseChannels(page, ['x', 'linkedin'])
  await expectSaved(page)

  await app.reload()
  await expect(page.getByTestId('post-header')).toHaveCount(2, { timeout: 60_000 })
  await inPreview(page, async () => {
    await previewOf(page, 'linkedin')
    await expect(page.getByTestId('preview-panel')).toContainText(
      'The thread is posted as one LinkedIn post.'
    )
    await expect(await previewOf(page, 'x')).toContainText('Second post')
  })
  const scheduleDialog = await openSchedule(page)
  await scheduleDialog.getByLabel('Open a new draft after scheduling').uncheck()
  await scheduleDialog.getByRole('button', { name: 'Confirm schedule' }).click()
  await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 30_000 })

  const rows = await db.rows<{ caption: string; platform: string; replies: unknown }>(
    `SELECT p.caption, c.platform, p.replies
         FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
         WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
  expect(rows).toEqual([
    { caption: 'First post\n\nSecond post', platform: 'linkedin', replies: null },
    {
      caption: 'First post',
      platform: 'x',
      replies: [{ assetIds: [], caption: 'Second post' }],
    },
  ])
})

// Comment threads are saved with the draft, so a reload still shows them.
test('a comment thread survives a reload', async ({ app, page, startWorkspace }) => {
  await startWorkspace({ channels: ['linkedin'] })
  await openNewDraft(page)
  await draftEditor(page).click()
  await page.keyboard.type('Launch day')
  await draftEditor(page).getByText('Launch day', { exact: true }).selectText()
  await page.getByRole('button', { name: 'Comment', exact: true }).click()
  // Focus the reply editor after the floating toolbar closes.
  await expect(page.getByText('Reply...')).toBeInViewport()
  const reply = page.getByRole('dialog').getByRole('textbox')
  await reply.fill('Check the date')
  await reply.press('Enter')
  await draftEditor(page).getByText('Launch day', { exact: true }).click()
  await expect(page.getByText('Check the date')).toBeVisible()
  await expectSaved(page)

  await app.reload()
  await draftEditor(page).getByText('Launch day', { exact: true }).click({ timeout: 60_000 })
  await expect(page.getByText('Check the date')).toBeVisible()
})

// DOCX and Markdown in and out. Imported images are stored as workspace
// assets, not left inline; the exported Word file opens and holds the text.
test('a draft imports and exports DOCX and Markdown', async ({ identity, page }) => {
  await createWorkspace(identity, page)
  const draftId = await openNewDraft(page)

  const docx = await buildDocx('Quarterly launch notes', png)
  await page.getByLabel('Import DOCX').setInputFiles({
    buffer: docx,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    name: 'launch.docx',
  })
  await expect(draftEditor(page)).toContainText('Quarterly launch notes', { timeout: 30_000 })
  await expect(draftEditor(page).locator('img[src*="/api/v1/assets/"]')).toBeVisible({
    timeout: 30_000,
  })

  await page.getByLabel('Import Markdown').setInputFiles({
    buffer: Buffer.from('## Highlights\n\n- Faster exports\n- Shared drafts\n'),
    mimeType: 'text/markdown',
    name: 'notes.md',
  })
  await expect(draftEditor(page).locator('h2')).toHaveText('Highlights')
  await expect(draftEditor(page)).toContainText('Shared drafts')
  await expectSaved(page)

  const stored = await db.row<{ assetIds: string[]; body: string }>(
    'SELECT "assetIds", body::text AS body FROM content_draft WHERE id = $1',
    [draftId]
  )
  expect(stored?.assetIds).toHaveLength(1)
  expect(stored?.body).not.toContain('data:image')
  expect(
    await db.row(`SELECT status::text AS status FROM asset WHERE id = $1`, [stored?.assetIds[0]])
  ).toEqual({ status: 'UPLOADED' })

  const [wordFile] = await Promise.all([
    page.waitForEvent('download'),
    exportAs(page, 'Export DOCX'),
  ])
  expect(wordFile.suggestedFilename()).toMatch(/\.docx$/)
  const exported = await JSZip.loadAsync(await readFile((await wordFile.path()) ?? ''))
  expect(await exported.file('word/document.xml')?.async('text')).toContain(
    'Quarterly launch notes'
  )

  const [markdownFile] = await Promise.all([
    page.waitForEvent('download'),
    exportAs(page, 'Export Markdown'),
  ])
  const markdown = await readFile((await markdownFile.path()) ?? '', 'utf8')
  expect(markdown).toContain('Quarterly launch notes')
  expect(markdown).toContain('## Highlights')
})

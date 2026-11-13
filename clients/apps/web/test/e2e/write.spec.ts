import { serializeDraft } from '../../lib/content-drafts/serialize'
import { bodyFor, readVersions } from '../../lib/write/versions'
import type { RevisionWire } from '../../lib/content-drafts/client'
import {
  apiRequest,
  db,
  draftEditor,
  enableDraftTags,
  expect,
  expectSaved,
  type Locator,
  type Page,
  settleSelection,
  test,
  openNewDraft,
  startPostByTyping,
} from './framework'

/**
 * Write (RFC 025) end to end: the library, the composer, platform
 * versions, previews, properties, planning, scheduling, backups and
 * sharing, on a desktop and a phone. Posts are scheduled for later or fail
 * using fixture-only credentials; blocked or rejected provider requests never reach an authorized account.
 */

/** A screenshot for the delivery report, once dialogs and sheets finish animating. */
async function snap(page: Page, name: string): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- Dialogs and sheets finish animating before the report screenshot.
  await page.waitForTimeout(500)
  await page.screenshot({ path: `.context/shots/${name}.png` })
}

/** Open a new draft from the library; returns its id. */
async function newDraft(page: Page): Promise<string> {
  return openNewDraft(page)
}

/**
 * Put the caret at the end of a text leaf, past slate's 100 ms selection
 * sync (the same helper as the drafts spec).
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

type PostRow = { caption: string; platform: string; status: string }

async function draftPosts(draftId: string): Promise<PostRow[]> {
  return await db.rows<PostRow>(
    `SELECT p.caption, c.platform, p.status::text AS status
       FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
       WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
}

test(
  'a thread is written once, adapted per platform, planned, scheduled, backed up and recovered',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const draftId = await newDraft(page)

    // The composer says who it publishes as, and every post shows its account.
    await expect(page.getByTestId('platform-tab-x')).toContainText('Main')
    await expect(page.getByTestId('platform-tab-linkedin')).not.toContainText('Own text')

    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)
    await page.keyboard.type('Launch day is here.')
    await page.keyboard.press('ControlOrMeta+Enter')
    await page.keyboard.type('Second post 🚀 https://example.com/launch')
    await expectSaved(page)
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expect(page.getByTestId('post-header').first()).toContainText('@shots_x')
    // X counts a link as 23 and an emoji as 2.
    await expect(page.getByTestId('post-length-1')).toHaveText('19 / 280')
    await expect(page.getByTestId('post-length-2')).toHaveText('38 / 280')

    // Numbering is applied when serialized and counted; the text never holds it.
    await page.getByTestId('options-chip').click()
    await page.getByRole('button', { name: /Auto-numbering/ }).click()
    await page.getByLabel('Enable auto-numbering').click()
    await expect(page.getByTestId('numbering-preview')).toContainText('1/2')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('post-length-1')).toHaveText(/^2\d \/ 280$/)
    await expect(editor).not.toContainText('1/2')
    await expectSaved(page)

    // LinkedIn follows X, joined into one post.
    await page.getByTestId('platform-tab-linkedin').click()
    await expect(page.getByTestId('synced-version-linkedin')).toContainText('Launch day is here.')
    await expect(page.getByTestId('synced-version-linkedin').locator('article')).toHaveCount(1)
    await snap(page, 'write-linkedin-synced')

    // Its own text: edits there stay there, and X edits no longer reach it.
    await page.getByRole('button', { name: 'Edit for LinkedIn independently' }).click()
    await expect(page.getByTestId('manual-version-linkedin')).toBeVisible()
    await editor.click()
    await settleSelection(page)
    // The end of the document: ⌘↓ on macOS, Ctrl+End elsewhere.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await settleSelection(page)
    await page.keyboard.type(' Read more on our blog.')
    await expectSaved(page)
    await page.getByTestId('platform-tab-x').click()
    await expect(editor).not.toContainText('Read more on our blog.')
    await caretAtEndOf(page, editor.getByText('Launch day is here.'))
    await page.keyboard.type(' Today!')
    await expectSaved(page)

    // Previews: each platform's own text, labelled as not published, no engagement.
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    const preview = page.getByTestId('preview-panel')
    await expect(preview).toContainText('not published')
    await expect(page.getByTestId('preview-x')).toContainText('Launch day is here. Today!')
    await snap(page, 'write-preview-x')
    await preview.getByRole('button', { name: 'LinkedIn' }).click()
    await expect(page.getByTestId('preview-linkedin')).toContainText('Read more on our blog.')
    await expect(page.getByTestId('preview-linkedin')).not.toContainText('Today!')
    await snap(page, 'write-preview-linkedin')
    // The preview and the editor show one platform, whichever of them changed it.
    await page.getByTestId('platform-tab-x').click()
    await expect(page.getByTestId('preview-x')).toBeVisible()

    // Properties: an internal title and scratchpad that are never posted, and counts.
    await page.getByRole('button', { name: 'Draft details', exact: true }).click()
    const properties = page.getByTestId('properties-panel')
    await properties.getByLabel('Internal title').fill('Launch thread')
    await properties.getByRole('textbox', { name: /Scratchpad/ }).fill('Ask legal about the claim')
    await expect(properties.getByTestId('word-count')).not.toHaveText('0')
    await expectSaved(page)
    await snap(page, 'write-properties')

    // Plan: on the calendar, never published by itself.
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await expect(schedule).toBeVisible()
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await expect(page.getByTestId('schedule-summary')).toContainText('9:00')
    await snap(page, 'write-schedule')
    await schedule.getByRole('button', { name: 'Save as planned' }).click()
    await expect(schedule).toBeHidden()
    await expect(page.getByText('Planned', { exact: true }).first()).toBeVisible()
    expect(await draftPosts(draftId)).toEqual([])

    // Schedule it: one post per platform, each with its own text.
    await page.getByTestId('schedule-button').click()
    await expect(schedule).toBeVisible()
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 30_000 })
    const posts = await draftPosts(draftId)
    expect(posts.map((post) => [post.platform, post.status])).toEqual([
      ['linkedin', 'SCHEDULED'],
      ['x', 'SCHEDULED'],
    ])
    expect(posts.find((post) => post.platform === 'linkedin')?.caption).toContain(
      'Read more on our blog.'
    )
    expect(posts.find((post) => post.platform === 'x')?.caption).toMatch(
      /^Launch day is here\. Today!/
    )
    expect(posts.map((post) => post.caption).join(' ')).not.toContain('Ask legal')
    await snap(page, 'write-scheduled')

    // Queued posts keep what was scheduled: an edit afterwards says so until it replaces them.
    await expect(page.getByTestId('draft-status')).toHaveText('Scheduled')
    await expect(page.getByTestId('queued-snapshot')).toHaveCount(0)
    await caretAtEndOf(page, editor.getByText('Launch day is here. Today!'))
    await page.keyboard.type(' Updated.')
    await expectSaved(page)
    // Only X changed: LinkedIn has its own text.
    await expect(page.getByTestId('queued-snapshot')).toHaveCount(1)
    expect((await draftPosts(draftId)).map((post) => post.caption).join(' ')).not.toContain(
      'Updated.'
    )
    await page.getByRole('button', { name: 'Replace queued posts with this version…' }).click()
    await expect(schedule.getByRole('heading', { name: 'Reschedule' })).toBeVisible()
    await expect(schedule.getByTestId('replaced-posts')).toContainText('moves to the new time')
    await expect(schedule.getByRole('button', { name: 'Confirm reschedule' })).toBeVisible()
    await page.keyboard.press('Escape')

    // The library: both posts in the queue; the draft found by its scratchpad, shown by its title.
    await app.open('/publish?tab=queue')
    await expect(page.getByTestId('write-rail')).toContainText('Launch day is here. Today! 1/2')
    await expect(page.getByTestId('write-rail')).toContainText('Read more on our blog.')
    await app.open('/publish?q=legal')
    await expect(page.getByTestId('draft-row')).toHaveCount(1)
    await expect(page.getByTestId('draft-row')).toContainText('Launch thread')
    await snap(page, 'write-library-search')

    // Backups: browsed, compared, and recovered as a new draft.
    await app.open(`/publish/${draftId}?panel=backups`)
    const backups = page.getByTestId('backups-browser')
    await expect(backups).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('backup-time')).toContainText(
      /When scheduled|When planned|While editing/
    )
    await snap(page, 'write-backups')
    await expect(backups.getByTestId('backup-content')).toBeVisible()
    const revisions = (await apiRequest(page, `/api/v1/content-drafts/${draftId}/revisions`))
      .body as { items: { id: string }[] }
    expect(revisions.items.length).toBeGreaterThan(1)
    const olderUrl = `/api/v1/content-drafts/${draftId}/revisions/${revisions.items[1].id}`
    const older = (await apiRequest(page, olderUrl)).body as RevisionWire
    expect(older.body).toBeDefined()
    const olderCaption = serializeDraft(
      bodyFor(older.body ?? [], readVersions(older.platformVersions), 'x'),
      'x'
    ).caption
    const olderPath = `**${olderUrl}`
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(olderPath, async (route) => {
      // Delay the real authorized read, then simulate a transport failure.
      await route.fetch()
      await held
      await route.abort('failed')
    })
    try {
      await backups.getByRole('button', { name: '← Prev' }).click()
      await expect(backups.getByTestId('backup-content')).toHaveCount(0)
      await expect(
        backups.getByRole('button', { name: 'Create new draft from this version' })
      ).toBeDisabled()
      await backups.getByRole('button', { name: 'Next →' }).click()
      await expect(backups.getByTestId('backup-content')).toBeVisible()
      await backups.getByRole('button', { name: '← Prev' }).click()
      await expect(backups.getByTestId('backup-content')).toHaveCount(0)
      release()
      await expect(backups.getByRole('button', { name: 'Retry loading version' })).toBeVisible()
      await expect(
        backups.getByRole('button', { name: 'Create new draft from this version' })
      ).toBeDisabled()
    } finally {
      release()
      await page.unroute(olderPath)
    }
    await backups.getByRole('button', { name: 'Retry loading version' }).click()
    await expect(backups.getByTestId('backup-content')).toBeVisible()
    await expect(
      backups.getByRole('button', { name: 'Create new draft from this version' })
    ).toBeEnabled()
    await expect(backups.getByTestId('backup-content')).toHaveText(olderCaption || 'Empty')
    const recoveryRequest = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().includes('/recover')
    )

    await backups.getByRole('button', { name: 'Create new draft from this version' }).click()
    await page.waitForURL(
      (url) => !url.pathname.endsWith(draftId) && /\/publish\/[a-z0-9]+/.test(url.pathname)
    )
    await expect(draftEditor(page)).toContainText('Launch day is here.', { timeout: 60_000 })
    expect(new URL((await recoveryRequest).url()).pathname).toBe(`${olderUrl}/recover`)
    const recovered = (
      await apiRequest(page, `/api/v1/content-drafts/${page.url().split('/').pop()}`)
    ).body as { body: unknown }
    expect(recovered.body).toEqual(older.body)
    expect(await draftPosts(draftId)).toHaveLength(2)

    // Sharing: copying the internal link never turns the public one on.
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const share = page.getByTestId('share-dialog')
    await expect(share.getByLabel('Public link', { exact: true })).not.toBeChecked()
    await share.getByLabel('Public link', { exact: true }).click()
    await expect(share.getByLabel('Public link to share')).toHaveValue(/\/d\//)
    const publicLink = await share.getByLabel('Public link to share').inputValue()
    await share.getByLabel('Public link', { exact: true }).click()
    await expect(share.getByLabel('Public link to share')).toHaveCount(0)
    const revoked = await page.request.get(publicLink)
    expect(revoked.status()).toBe(404)
  }
)

test(
  'refine previews and applies only on accept, the assistant adds a post, follow-ups are set in review, and a failed destination is retried alone',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const draftId = await newDraft(page)
    const editor = draftEditor(page)
    await editor.click()
    await settleSelection(page)
    await page.keyboard.type('we shipped the new editor today')
    await expectSaved(page)

    // Refine: the answer is previewed; Reject leaves the text as it was.
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click()
    await page.getByTestId('refine-menu').getByRole('button', { name: 'Fix grammar' }).click()
    const review = page.getByTestId('refine-review')
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await snap(page, 'write-refine-review')
    await review.getByRole('button', { name: 'Reject' }).click()
    await expect(editor).toHaveText(/we shipped the new editor today/)
    await expect(editor).not.toContainText('(refined)')

    // Accept applies it as one change, and Undo takes it back.
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click()
    await page.getByTestId('refine-menu').getByRole('button', { name: 'Make it punchier' }).click()
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await review.getByRole('button', { name: 'Accept' }).click()
    await expect(editor).toContainText('we shipped the new editor today (refined)')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(editor).not.toContainText('(refined)')
    await expect(editor).toContainText('we shipped the new editor today')
    await expectSaved(page)

    // Try again asks the same thing again, not the empty instruction box.
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click()
    const menu = page.getByTestId('refine-menu')
    await menu.getByLabel('Refine instruction').fill('Make it friendlier')
    await menu.getByRole('button', { name: 'Go', exact: true }).click()
    await expect(review).toContainText('Make it friendlier')
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await review.getByRole('button', { name: 'Try again' }).click()
    await expect(review).toContainText('Make it friendlier', { timeout: 60_000 })
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await review.getByRole('button', { name: 'Reject' }).click()
    await expect(editor).not.toContainText('(refined)')

    // The writing assistant helps at once; its voice setup is offered later, never as a gate.
    await page.getByRole('button', { name: 'Assistant', exact: true }).click()
    await expect(page.getByTestId('assistant-setup')).toHaveCount(0)
    const assistant = page.getByTestId('assistant-panel')
    await assistant.getByRole('button', { name: /stronger hooks/ }).click()
    await expect(assistant.getByTestId('assistant-assistant')).toHaveCount(1, { timeout: 60_000 })
    await snap(page, 'write-assistant')
    await assistant.getByRole('button', { name: 'Add as a new post' }).click()
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expectSaved(page)
    // After three answers with no style guide, the assistant offers its voice setup.
    await expect(assistant.getByRole('button', { name: 'Set up its voice' })).toHaveCount(0)
    for (const [index, question] of ['Make it shorter.', 'Add a question at the end.'].entries()) {
      await assistant.getByLabel('Ask the assistant').fill(question)
      await assistant.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(assistant.getByTestId('assistant-assistant')).toHaveCount(index + 2, {
        timeout: 60_000,
      })
    }
    await assistant.getByRole('button', { name: 'Set up its voice' }).click()
    await expect(page.getByTestId('assistant-setup')).toBeVisible()
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
    await expect(page.getByTestId('assistant-panel')).toBeVisible()

    // The review names every account and the follow-ups; Auto-DM is off, with why.
    await page.getByTestId('publish-button').click()
    const publish = page.getByTestId('publish-review')
    await expect(publish).toContainText('Publishing as')
    await expect(publish.getByTestId('review-destination')).toHaveCount(2)
    await publish.getByText('More options', { exact: true }).click()
    await expect(publish.getByTestId('automation-auto-dm')).toContainText('authorized X messaging')
    await expect(publish.getByTestId('automation-auto-dm').getByRole('switch')).toBeDisabled()
    await publish.getByTestId('automation-auto-rt').getByRole('switch').click()
    const autoRT = page.getByTestId('auto-rt-dialog')
    await expect(autoRT.getByTestId('retweet-projection')).toContainText('reposts')
    await snap(page, 'write-auto-rt')
    await autoRT.getByRole('button', { name: 'Enable Auto-RT' }).click()
    await expect(publish.getByTestId('automation-auto-rt')).toContainText(
      '6 hours after publishing'
    )
    await expect(publish).toContainText(
      'X: repost 6 hours after publishing, removed 12 hours later.'
    )
    await snap(page, 'write-publish-review')

    // Commit through Publish now, then seed confirmed provider failures.
    // Worker outcome semantics are covered by the Go state-machine tests;
    // this browser case never sends fixture credentials to real providers.
    await publish.getByRole('button', { name: 'Publish now' }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 30_000 })
    await db.query(
      // A running worker may already have claimed the posts.
      `UPDATE scheduled_post SET status='FAILED' WHERE "contentDraftId"=$1 AND status IN ('SCHEDULED', 'PROCESSING')`,
      [draftId]
    )
    expect((await draftPosts(draftId)).map((post) => post.status).sort()).toEqual([
      'FAILED',
      'FAILED',
    ])
    await app.reload()
    const unknown = page.getByTestId('draft-post').filter({ hasText: 'Needs check' })
    while (await unknown.count()) {
      const remaining = await unknown.count()
      await expect(
        unknown.first().getByRole('button', { name: 'Retry this destination' })
      ).toHaveCount(0)
      await unknown.first().getByRole('button', { name: 'I checked the account…' }).click()
      // This fixture has no real provider credential, so publication is known not to exist.
      await page.getByRole('button', { name: 'It is not there', exact: true }).click()
      await expect
        .poll(
          async () =>
            (await draftPosts(draftId)).filter((post) => post.status === 'UNKNOWN_DELIVERY').length
        )
        .toBe(remaining - 1)
      await expect(unknown).toHaveCount(remaining - 1)
    }
    expect((await draftPosts(draftId)).map((post) => post.status)).toEqual(['FAILED', 'FAILED'])
    const failed = page.getByTestId('draft-post').filter({ hasText: 'did not publish' })
    await expect(failed).toHaveCount(2, { timeout: 60_000 })
    await snap(page, 'write-failed-destinations')

    // Retrying one destination makes one new post for it; the other stays as it is.
    // A running worker can fail the LinkedIn fixture as needing a reconnect. Its account
    // then blocks a retry, so retry the first destination that offers one.
    await failed.getByRole('button', { name: 'Retry this destination' }).first().click()
    await expect.poll(async () => (await draftPosts(draftId)).length, { timeout: 30_000 }).toBe(3)
  }
)

test(
  'on a phone the library is the page, panels are sheets, and the review keeps the account identity',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await page.setViewportSize({ height: 844, width: 390 })
    await app.open('/publish')
    await expect(page.getByTestId('write-rail')).toBeVisible()
    await snap(page, 'write-phone-library')
    await startPostByTyping(page, 'Written on a phone.')
    await expectSaved(page)
    await expect(page.getByTestId('save-state')).toBeVisible()
    await snap(page, 'write-phone-composer')

    // The library is a drawer while a draft is open.
    await page.getByRole('button', { name: 'Drafts', exact: true }).click()
    await expect(page.getByRole('dialog').getByTestId('write-rail')).toBeVisible()
    await snap(page, 'write-phone-drawer')
    await page.keyboard.press('Escape')

    // Panels open as a sheet over the draft.
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    await expect(page.getByTestId('preview-x')).toContainText('Written on a phone.')
    await snap(page, 'write-phone-preview')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()

    // Schedule stays in the header on a phone; Publish now is one menu away and still reviewed.
    await expect(page.getByTestId('schedule-button')).toBeVisible()
    await expect(page.getByTestId('publish-button')).toBeHidden()
    await page.getByRole('button', { name: 'More draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Publish now…' }).click()
    // The final review still names the set and each account.
    const publish = page.getByTestId('publish-review')
    await expect(publish).toContainText('Publishing as')
    await expect(publish.getByTestId('review-destination').first()).toContainText('@shots_')
    await snap(page, 'write-phone-review')
    await page.keyboard.press('Escape')
    const previousId = page.url().match(/\/publish\/([a-z0-9]+)/)![1]
    const previous = (await apiRequest(page, `/api/v1/content-drafts/${previousId}`)).body as {
      socialSetId: string
    }
    await page.getByTestId('mobile-new-draft').click()
    await page.keyboard.type('Next.')
    await page.waitForURL(
      (url) => /\/publish\/[a-z0-9]+/.test(url.pathname) && !url.pathname.endsWith(previousId)
    )
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    await expect(draftEditor(page)).not.toContainText('Written on a phone.')
    const nextId = page.url().match(/\/publish\/([a-z0-9]+)/)![1]
    const next = (await apiRequest(page, `/api/v1/content-drafts/${nextId}`)).body as {
      socialSetId: string
    }
    expect(next.socialSetId).toBe(previous.socialSetId)
    expect(await draftPosts(nextId)).toHaveLength(0)
    await app.open(`/publish/${previousId}`)
    await expect(draftEditor(page)).toContainText('Written on a phone.')
  }
)

test(
  'the library organizes drafts: tags, pins, kinds, duplicates, copies to a same-named set, bulk delete, the command palette and the Plan calendar',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const rows = () => page.getByTestId('draft-row')
    const rowMenu = async (title: string) => {
      await rows().filter({ hasText: title }).first().hover()
      await page
        .getByRole('button', { name: `Actions for ${title}` })
        .first()
        .click()
    }
    // Menu items are chosen from the keyboard: their open animation can keep
    // Playwright's stability check from settling.
    const choose = async (name: string) => {
      const prefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      const item = page.getByRole('menuitem', { name: prefix }).last()
      await item.focus()
      await page.keyboard.press('Enter')
    }
    await startWorkspace({ channels: ['x', 'linkedin'] })
    await enableDraftTags(page)
    const first = await newDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('First draft about pricing')
    await page.getByRole('textbox', { name: 'Draft title' }).fill('Pricing')
    await expectSaved(page)

    // A tag of this set, put on the draft from its row, then used as a filter.
    await app.open('/publish')
    await page.getByRole('button', { name: 'Draft filters' }).click()
    await choose('Manage tags…')
    await page.getByLabel('Tag name').fill('Launch')
    await page.getByRole('button', { name: 'Create tag' }).click()
    await expect(page.getByRole('dialog')).toContainText('Launch')
    await page.keyboard.press('Escape')
    await rowMenu('Pricing')
    await page.getByRole('menuitem', { name: 'Tag this draft' }).click()
    await page
      .getByRole('menuitemcheckbox', { name: 'Launch' })
      .or(page.getByRole('menuitem', { name: 'Launch' }))
      .click()
    await page.keyboard.press('Escape')

    // Pin it; a pinned draft comes first and says so.
    await rowMenu('Pricing')
    await choose('Pin draft')
    await expect(rows().first().getByLabel('Pinned')).toBeVisible()

    // A reply draft carries the post it answers.
    await page.getByRole('button', { name: 'New draft of another kind' }).first().click()
    await choose('Reply to an X post')
    await page.getByLabel('Post URL').fill('https://x.com/someone/status/1234567890')
    await page.getByRole('button', { name: 'Start writing' }).click()
    await page.waitForURL(
      (url) => !url.pathname.endsWith(first) && /\/publish\/[a-z0-9]+/.test(url.pathname)
    )
    await expect(page.getByTestId('draft-target')).toContainText('Replying to')
    await expect(page.getByTestId('draft-target')).toContainText('x.com/someone/status/1234567890')

    // Duplicate: a new draft with the text, no schedule or link.
    await app.open('/publish')
    await rowMenu('Pricing')
    await choose('Duplicate')
    await expect(rows().filter({ hasText: 'Pricing' })).toHaveCount(2)

    // A second set with the same name as the default stays a separate identity.
    // Sets are made in workspace settings (RFC 024); the switcher links there.
    const setName =
      (await page.getByRole('button', { name: /^Profile: / }).textContent())?.trim() ?? ''
    await page.getByRole('button', { name: /^Profile: / }).click()
    await expect(page.getByRole('menuitem', { name: 'New profile…' })).toHaveAttribute(
      'href',
      /\/settings\/publishing-brands$/
    )
    await page.keyboard.press('Escape')
    const created = await apiRequest(page, '/api/v1/social-sets', {
      body: { name: setName.replace(/▾$/, '').trim() },
      method: 'POST',
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const secondSet = (created.body as { id: string }).id

    // Copy to that set: the copy is found there; the original stays here.
    // Open the new set, then switch back to the default (listed first).
    // Both brands share a name, so the screen cannot show which one is
    // open; only the settled network shows a switch has finished.
    const switchSet = async (index: number) => {
      // eslint-disable-next-line no-restricted-syntax -- see above.
      await page.waitForLoadState('networkidle')
      await page.getByRole('button', { name: /^Profile: / }).click()
      const item = page
        .getByRole('menuitem')
        .filter({ hasText: setName.replace(/▾$/, '').trim() })
        .nth(index)
      await item.focus()
      await page.keyboard.press('Enter')
      // eslint-disable-next-line no-restricted-syntax -- see above.
      await page.waitForLoadState('networkidle')
    }
    await app.open(`/publish?set=${secondSet}`)
    await expect(page.getByText('No drafts in this profile.')).toBeVisible()
    await switchSet(0)
    await rowMenu('Pricing')
    await page.getByRole('menuitem', { name: 'Copy to profile' }).click()
    await page.getByRole('menu').last().getByRole('menuitem').first().click()
    await page.getByRole('button', { name: 'Copy without tags' }).click()
    await expect(page.getByText(/Copied/).first()).toBeVisible()
    // The copy opens in its set.
    await page.waitForURL(/\/publish\/[a-z0-9]+\?set=/)
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    await switchSet(1)
    await expect(rows().filter({ hasText: 'Pricing' })).toHaveCount(1)
    await switchSet(0)
    // Back on the default set: the original and its duplicate.
    await expect(rows().filter({ hasText: 'Pricing' })).toHaveCount(2)

    // Select several and delete them after a confirmation.
    await rowMenu('Pricing')
    await choose('Select multiple')
    // In selection mode a click on a row selects it instead of opening it.
    await rows().filter({ hasText: 'Pricing (copy)' }).getByRole('link').click()
    const bulk = page.getByLabel('Selected drafts')
    await expect(bulk).toContainText('2 selected')
    await bulk.getByRole('button', { name: 'Delete' }).click()
    await expect(page.getByRole('alertdialog')).toContainText('Delete 2 drafts?')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete drafts' }).click()
    await expect(rows().filter({ hasText: 'Pricing' })).toHaveCount(0, { timeout: 30_000 })
    await snap(page, 'write-library-bulk')

    // The command palette finds drafts and runs commands; the shortcut list opens and closes.
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette).toBeVisible()
    await page.keyboard.type('reply')
    await snap(page, 'write-command-palette')
    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+Shift+Slash')
    await expect(page.getByTestId('shortcut-reference').first()).toContainText(
      'Search and commands'
    )
    await snap(page, 'write-shortcuts')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcut-reference')).toHaveCount(0)

    // Plan: a planned draft shows dashed on the week it is planned for.
    const planned = await newDraft(page)
    await draftEditor(page).click()
    await settleSelection(page)
    await page.keyboard.type('Planned, not scheduled')
    await expectSaved(page)
    await page.getByTestId('schedule-button').click()
    await page
      .getByTestId('schedule-dialog')
      .getByRole('button', { name: /^Tomorrow 9:00/ })
      .click()
    await page
      .getByTestId('schedule-dialog')
      .getByRole('button', { name: 'Save as planned' })
      .click()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    await app.open(`/publish/calendar?week=${tomorrow}`)
    const plannedCard = page
      .getByTestId('calendar-planned')
      .filter({ hasText: 'Planned, not scheduled', visible: true })
    await expect(plannedCard).toBeVisible({ timeout: 30_000 })
    await plannedCard.click()
    await expect(page.getByRole('link', { name: 'Open in editor', exact: true })).toHaveAttribute(
      'href',
      `/publish/${planned}`
    )
    await page.keyboard.press('Escape')
    await snap(page, 'write-plan')
  }
)

test(
  'draft text survives replacement and navigation; details, filters, archive and calendar remain actionable',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })
    const draftId = await newDraft(page)
    const editor = draftEditor(page)
    await expect(editor).toBeFocused()
    // An X draft asks as X does, with the slash menu's hint (a CSS variable drawn as the placeholder).
    await expect(editor).toHaveCSS(
      '--post-placeholder',
      '"What’s happening?   Type / for commands"'
    )
    await expect(editor.locator('[placeholder]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add to thread', exact: true })).toBeInViewport()
    await editor.fill('QA persistence check two')
    await expect(page.getByTestId('post-length-1')).toHaveText('24 / 280')
    await expectSaved(page)
    await app.reload()
    await expect(editor).toContainText('QA persistence check two')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.getByRole('button', { name: 'Emoji', exact: true }).click()
    await page.getByRole('combobox', { name: 'Search emoji' }).fill(':rocket')
    await page.getByRole('option', { name: 'Rocket :rocket:', exact: true }).click()
    await expect(editor).toBeFocused()
    await page.keyboard.type(' after emoji')
    await expect(editor).toContainText('🚀 after emoji')
    await expectSaved(page)
    await app.reload()
    await expect(editor).toContainText('🚀 after emoji')
    await editor.click()
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('Replacement text')
    await expect(editor).toContainText('Replacement text')
    await expect(page.getByTestId('post-header')).toHaveCount(1)
    await page.getByRole('textbox', { name: 'Draft title' }).fill('Persistence regression')
    await expectSaved(page)
    await expect(
      page.getByRole('button', { name: 'Actions for Persistence regression', exact: true })
    ).toHaveCount(1)

    await page.getByRole('button', { name: 'Draft details', exact: true }).click()
    await expect(page.getByTestId('word-count')).toHaveText('2')
    await page.setViewportSize({ width: 1280, height: 900 })
    const panel = await page
      .getByRole('complementary', { name: 'Draft details', exact: true })
      .boundingBox()
    const publish = await page.getByTestId('publish-button').boundingBox()
    expect(panel && publish && publish.x + publish.width <= panel.x).toBeTruthy()
    await page.getByRole('button', { name: 'Add to thread', exact: true }).click()
    await page.keyboard.type('Second post')
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    await expect(page.getByTestId('post-length-2')).toHaveText('11 / 280')
    // A thread says what it is and how it publishes; the next post is a separate one.
    await expect(page.getByTestId('thread-label')).toHaveText(
      'Thread · 2 posts · post 2 replies to post 1 on X'
    )
    await expect(
      page.getByTestId('writing-bar').getByRole('button', { name: 'New standalone post' })
    ).toBeVisible()

    // Leave during the debounce, through an in-app link.
    await page.getByRole('link', { name: 'Calendar', exact: true }).click()
    await expect
      .poll(async () => {
        const result = await apiRequest(page, `/api/v1/content-drafts/${draftId}`)
        return (result.body as { plainText: string }).plainText
      })
      .toContain('Second post')
    await app.open(`/publish/${draftId}`)
    await expect(editor).toContainText('Second post')
    await page.getByTestId('schedule-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await expect(schedule.getByLabel('Time', { exact: true })).toBeVisible()
    await expect(schedule.getByLabel('When, in words')).toBeHidden()
    await schedule.getByText('More options', { exact: true }).click()
    await schedule.getByLabel('When, in words').fill('definitely not a time')
    await expect(schedule.getByTestId('when-reading')).toContainText('Still selected:')
    await schedule.getByRole('button', { name: /^Tomorrow 9:00/ }).click()
    await schedule.getByRole('button', { name: 'Save as planned' }).click()
    await page.getByRole('button', { name: 'More draft actions' }).click()
    await page.getByRole('menuitem', { name: 'Archive draft' }).click()
    await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toBeVisible()
    await expect(page.getByTestId('publish-button')).toHaveCount(0)
    await app.open('/publish?tab=archived')
    const archived = page.getByTestId('draft-row').filter({ hasText: 'Persistence regression' })
    await expect(archived).toContainText('Previously planned')
    await archived.getByRole('button', { name: 'Actions for Persistence regression' }).click()
    await page.getByRole('menuitem', { name: 'Restore draft', exact: true }).click()
    await expect(archived).toHaveCount(0)

    await app.open('/publish?kind=article')
    await expect(page.getByRole('button', { name: 'Remove Article filter' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Remove Article filter' })).toHaveCount(0)
    await test.step('library filters are in the URL and survive a reload', async () => {
      await app.open('/publish?tab=all')
      await expect(page.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await page.getByRole('button', { name: 'Draft filters' }).click()
      await page.getByRole('menuitemradio', { name: 'Today', exact: true }).click()
      await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}/)
      await app.reload()
      await page.getByRole('button', { name: 'Draft filters' }).click()
      await expect(page.getByRole('menuitemradio', { name: 'Today', exact: true })).toBeChecked()
      await page.keyboard.press('Escape')
      // Nothing in this workspace is on a day before it existed.
      await app.open('/publish?tab=all&from=2020-01-01&to=2020-01-02')
      await expect(page.getByText('Nothing matches these filters.')).toBeVisible()
      await page.getByRole('button', { name: 'Clear filters', exact: true }).first().click()
      await expect(page).not.toHaveURL(/[?&]from=/)
      await page.getByRole('tab', { name: /^Queue/ }).click()
      await expect(
        page.getByText('Free slots for the next 7 days, and posts for the next 60 days.')
      ).toBeVisible()
    })
    await app.open('/publish/calendar')
    await page
      .getByRole('button', { name: /^Create draft / })
      .first()
      .click()
    await expect(
      page.getByRole('dialog').getByRole('heading', { name: 'Plan a draft' })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await draftPosts(draftId)).toEqual([])
  }
)

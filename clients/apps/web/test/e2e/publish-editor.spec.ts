import {
  apiRequest,
  db,
  draftEditor,
  expect,
  expectSaved,
  openNewDraft,
  type Page,
  test,
} from './framework'

/**
 * The Publish editor writes first and queues fast: a new draft opens to its
 * text, the next free slot is a keyboard path with Undo, every surface reads
 * one status, and blockers show beside Schedule before anything is queued.
 * Posts go to fixture accounts and are scheduled for later; nothing reaches
 * a real account.
 */

test.use({ viewport: { height: 900, width: 1440 } })

/**
 * Every day at 10:30 and 18:30 in New York, so the next seven days have free
 * slots. Neither is the schedule dialog's own default time (09:00), so a check
 * that the dialog opens at a slot can fail.
 */
async function weeklySlots(page: Page): Promise<string> {
  const sets = await apiRequest(page, '/api/v1/social-sets')
  const [set] = (sets.body as { items: { id: string; name: string; version: number }[] }).items
  const saved = await apiRequest(page, `/api/v1/social-sets/${set.id}`, {
    method: 'PATCH',
    body: {
      baseVersion: set.version,
      name: set.name,
      postingSlots: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { time: '10:30', weekday },
        { time: '18:30', weekday },
      ]),
      timeZone: 'America/New_York',
    },
  })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  return set.id
}

async function draftPosts(draftId: string) {
  return await db.rows<{ id: string; platform: string; status: string }>(
    `SELECT p.id, c.platform, p.status::text AS status
       FROM scheduled_post p JOIN channel_connection c ON c.id = p."channelConnectionId"
      WHERE p."contentDraftId" = $1 ORDER BY c.platform`,
    [draftId]
  )
}

test(
  'a new draft opens to its text and joins the queue by keyboard, with Undo',
  { tag: '@journey' },
  async ({ identity, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await weeklySlots(page)
    // The old editor showed post options above the text when this was set.
    await page.evaluate(() => localStorage.setItem('shots-post-options', 'open'))
    const id = await openNewDraft(page)
    // Nothing that asks for input sits between the header and the first post.
    const between = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="write-composer"] header')
      const body = document.querySelector('[data-testid="composer-body"] [contenteditable="true"]')
      if (!header || !body) return { controls: -1, top: -1 }
      const top = header.getBoundingClientRect().bottom
      const bottom = body.getBoundingClientRect().top
      const composer = document.querySelector('[data-testid="write-composer"]')
      const controls = [
        ...(composer ?? document).querySelectorAll(
          'input:not([type=hidden]),select,textarea,[role=checkbox],[role=combobox]'
        ),
      ].filter((element) => {
        const box = element.getBoundingClientRect()
        return box.height > 0 && box.top >= top && box.bottom <= bottom
      }).length
      return { controls, top: bottom }
    })
    expect(between.controls).toBe(0)
    expect(between.top).toBeLessThan(450)
    // The caret is already in the post: typing needs no click.
    await page.keyboard.type('Queued by keyboard alone.')
    await expect(draftEditor(page)).toContainText('Queued by keyboard alone.')
    await expectSaved(page)
    await page.screenshot({ path: '.context/shots/publish-new-draft-1440.png' })

    await page.keyboard.press('ControlOrMeta+Alt+Enter')
    const dialog = page.getByTestId('schedule-dialog')
    await expect(dialog.getByTestId('schedule-summary')).toContainText('Next free slot')
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await expect(dialog.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled()
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(dialog).toBeHidden()
    await expect
      .poll(async () => (await draftPosts(id)).map((post) => post.status))
      .toEqual(['SCHEDULED', 'SCHEDULED'])
    // Undo works for a sign-in older than the 15 minutes a cancel asks for.
    await db.query(
      `UPDATE session SET "createdAt" = now() - interval '20 minutes' WHERE "userId" IN (SELECT id FROM "user" WHERE email = $1)`,
      [identity.email]
    )
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(page.getByText('Undone. Nothing from that schedule will publish.')).toBeVisible()
    await expect
      .poll(async () => (await draftPosts(id)).map((post) => post.status))
      .toEqual(['CANCELLED', 'CANCELLED'])
    // The draft is back as it was: a draft with no plan date.
    const draft = await db.row<{ plannedFor: Date | null; status: string }>(
      `SELECT status::text AS status, "plannedFor" FROM content_draft WHERE id = $1`,
      [id]
    )
    expect(draft).toEqual({ plannedFor: null, status: 'draft' })
  }
)

test(
  'every surface reads one status, and a failure names its cause and a fix',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await weeklySlots(page)
    const id = await openNewDraft(page)
    await page.keyboard.type('One destination fails.')
    await expectSaved(page)
    await page.getByTestId('queue-button').click()
    const dialog = page.getByTestId('schedule-dialog')
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await draftPosts(id)).length).toBe(2)
    // As the publisher leaves it when the account's credentials lapsed.
    const [bluesky] = await draftPosts(id)
    await db.row(
      `UPDATE scheduled_post SET status = 'FAILED', "failureCode" = 'ACCOUNT_RECONNECT'
        WHERE id = $1 RETURNING id`,
      [bluesky.id]
    )
    await app.reload()
    await expect(page.getByTestId('draft-status')).toHaveText('Failed · 1 of 2')
    await page.getByRole('button', { name: 'Draft details', exact: true }).click()
    await expect(page.getByTestId('properties-status')).toHaveText('Failed · 1 of 2')
    await page.getByRole('button', { name: 'Close Draft details' }).click()
    const failed = page.getByTestId('draft-post').filter({ hasText: 'Failed' })
    await expect(failed).toContainText('The account must be reconnected')
    await expect(failed.getByRole('link', { name: 'Reconnect the account' })).toBeVisible()
    await failed.getByRole('button', { name: 'Details', exact: true }).click()
    await expect(page.getByTestId('failure-details')).toContainText('ACCOUNT_RECONNECT')
    await page.keyboard.press('Escape')
    await page.screenshot({ path: '.context/shots/publish-failure-1440.png', fullPage: true })
    // The drafts list reads the same words.
    await page.goto('/write')
    // A failure has its own tab and count, and leaves the Drafts tab.
    await expect(page.getByTestId('failed-count')).toHaveText('1')
    await expect(page.getByTestId('draft-row')).toHaveCount(0)
    await page.getByTestId('library-tab-failed').click()
    await expect(page.getByTestId('draft-row')).toHaveCount(1)
    await expect(page.getByTestId('write-rail')).toContainText('Failed · 1 of 2')
    // Opening a post keeps the list on the tab it was opened from.
    await page.getByTestId('draft-row').getByRole('link').first().click()
    await expect(page).toHaveURL(/tab=failed/)
    await expect(page.getByTestId('library-tab-failed')).toHaveAttribute('aria-selected', 'true')
  }
)

test(
  'at a laptop width nothing in the editor is cut off or drawn over',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await page.setViewportSize({ height: 800, width: 1156 })
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await openNewDraft(page)
    await page.keyboard.type('Everything fits at a laptop width.')
    await expectSaved(page)
    const composer = page.getByTestId('write-composer')
    // Nothing widens the page: its scroller has no sideways scroll.
    expect(
      await composer.evaluate((element) => {
        const main = element.closest('main')!
        return main.scrollWidth - main.clientWidth
      })
    ).toBeLessThanOrEqual(0)
    const column = await composer.boundingBox()
    for (const control of [
      page.getByRole('toolbar', { name: 'Draft tools' }),
      page.getByTestId('platform-tabs'),
      page.getByTestId('options-chip'),
    ]) {
      const box = await control.boundingBox()
      expect(box && column && box.x + box.width <= column.x + column.width).toBeTruthy()
    }
    // Preview takes the draft's place, so the header keeps its full width and one row.
    const before = await page.getByTestId('publish-button').boundingBox()
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    await expect(page.getByTestId('preview-panel')).toBeVisible()
    expect(await page.getByTestId('publish-button').boundingBox()).toEqual(before)
  }
)

test(
  'blockers show beside Schedule, an empty thread post is named, and empty slots invite a draft',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await weeklySlots(page)
    await openNewDraft(page)
    await page.keyboard.type('x'.repeat(290))
    await expectSaved(page)
    // The palette lists this draft's actions, with their shortcuts.
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    await expect(palette.getByRole('option', { name: /^Add to the next free slot/ })).toBeVisible()
    await expect(
      palette.getByRole('option', { name: 'Duplicate draft', exact: true })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    // From another tab, a blocker opens the platform it belongs to.
    await page.getByTestId('platform-tab-bluesky').click()
    await page.getByTestId('blockers-button').click()
    const blockers = page.getByTestId('blockers')
    await expect(blockers).toContainText('X: 290 of 280 characters')
    await blockers.getByRole('button', { name: /^X: 290 of 280/ }).click()
    await expect(page.getByTestId('platform-tab-x')).toHaveAttribute('aria-selected', 'true')

    await page.getByRole('button', { name: 'Add post', exact: true }).click()
    await expect(page.getByTestId('empty-post-2')).toContainText('Empty, not sent')
    await page.getByRole('button', { name: 'Remove empty post' }).click()
    await expect(page.getByTestId('post-header')).toHaveCount(1)

    // Fewer than three posts are queued this week: Home asks for one.
    await page.goto('/home')
    await expect(page.getByTestId('queue-nudge')).toContainText('Write one now')

    await page.goto('/write?tab=queue')
    const queue = page.getByTestId('queue')
    await expect(queue.getByTestId('queue-goal')).toContainText('slots filled in the next 7 days')
    await expect(queue.getByRole('link', { name: 'Edit schedule' })).toBeVisible()
    const slot = queue.getByTestId('queue-free-slot').first()
    await expect(slot).toBeVisible()
    await page.screenshot({ path: '.context/shots/publish-queue-1440.png' })
    await slot.getByRole('button', { name: '+ New' }).click()
    await page.waitForURL(/day=\d{4}-\d{2}-\d{2}&time=\d{2}:\d{2}/)
    const slotUrl = new URL(page.url())
    const day = slotUrl.searchParams.get('day') ?? ''
    const time = slotUrl.searchParams.get('time') ?? ''
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('schedule-button').click()
    // The dialog opens on that slot's day and time, not on its own defaults.
    const [year, month, date] = day.split('-').map(Number)
    await expect(page.getByLabel('Day', { exact: true })).toHaveText(
      new Date(year, month - 1, date).toLocaleDateString('en-US', { dateStyle: 'medium' })
    )
    const [hour, minute] = time.split(':').map(Number)
    await expect(page.getByLabel('Time', { exact: true })).toHaveValue(
      `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
    )
  }
)

test(
  'a platform that cannot post is one click away from removal, the main version moves on, and a live post locks',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'threads', 'tiktok', 'instagram'] })
    await weeklySlots(page)
    const id = await openNewDraft(page)
    await page.keyboard.type('Plain text, with no media.')
    // They switch themselves off for lacking media; keeping them on leaves something to fix.
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expectSaved(page)

    // Every platform with something to fix says so on its tab, and the list offers to drop it.
    await expect(page.getByTestId('platform-blocked-tiktok')).toBeVisible()
    await expect(page.getByTestId('platform-blocked-instagram')).toBeVisible()
    for (const label of ['TikTok', 'Instagram']) {
      if (!(await page.getByTestId('blockers').isVisible()))
        await page.getByTestId('blockers-button').click()
      await page.getByRole('button', { name: `Remove ${label} from this post` }).click()
      await expect(page.getByRole('switch', { name: `Publish to ${label}` })).not.toBeChecked()
    }
    await expect(page.getByTestId('blockers-button')).toHaveCount(0)

    // Turning the main platform off hands the main version on; its tab stays to turn back on.
    await page.getByRole('switch', { name: 'Publish to X' }).click()
    await expect(page.getByRole('switch', { name: 'Publish to X' })).not.toBeChecked()
    await expect(page.getByTestId('platform-tab-threads')).toContainText('Main')
    await expectSaved(page)

    await page.getByTestId('queue-button').click()
    const schedule = page.getByTestId('schedule-dialog')
    await schedule.getByLabel('Open a new draft after scheduling').uncheck()
    await schedule.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect(schedule).toBeHidden()
    await expect.poll(async () => (await draftPosts(id)).length).toBe(1)
    const [post] = await draftPosts(id)
    await db.row(
      `UPDATE scheduled_post SET status = 'PUBLISHED', "publishedAt" = now()
        WHERE id = $1 RETURNING id`,
      [post.id]
    )

    // Edits could not reach it, so the text says that and takes none.
    await app.reload()
    await expect(page.getByTestId('live-notice')).toContainText('live on Threads')
    await expect(page.getByTestId('post-again-button')).toBeVisible()
    await expect(page.getByRole('toolbar', { name: 'Draft tools' })).toHaveCount(0)
    await app.open('/home')
    await expect(page.getByRole('region', { name: 'Continue working' })).toContainText('Published')
  }
)

test(
  'a platform that needs media switches itself off with an undo, and each tab has its own switch',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'tiktok'] })
    await openNewDraft(page)
    const tiktok = page.getByRole('switch', { name: 'Publish to TikTok', exact: true })
    // An empty post leaves it alone: the person may be about to attach a video.
    await expect(tiktok).toBeChecked()
    await page.keyboard.type('Words but no video.')
    await expect(tiktok).not.toBeChecked()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(tiktok).toBeChecked()
    // Having chosen to keep it, more typing does not switch it off again; the fix list explains it.
    await page.keyboard.type(' More words.')
    await expectSaved(page)
    await expect(tiktok).toBeChecked()
    await expect(page.getByTestId('platform-blocked-tiktok')).toBeVisible()
    // Off is a state of the tab, not its removal.
    await tiktok.click()
    await expect(tiktok).not.toBeChecked()
    await expect(page.getByTestId('platform-tab-tiktok')).toBeVisible()
  }
)

import { apiRequest, db, draftEditor, expect, expectSaved, type Page, test } from './framework'

/**
 * Publishing a run of written posts in one sitting. A writer who has drafted
 * a week of posts elsewhere pastes the block once, splits it into separate
 * posts, times them all in one step, then edits the run from the queue. The
 * second journey is the editor's own path: schedule, carry the platforms and
 * the next time to a new draft, and keep going.
 *
 * Posts go to fixture accounts at future times; nothing reaches a real one.
 */

test.use({ viewport: { height: 1000, width: 1440 } })

/** Every day at 10:30 and 18:30 in New York, so the brand has free slots. */
async function weeklySlots(page: Page): Promise<void> {
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
}

/** Paste into a field the way a clipboard does, so the split offer is reached. */
async function pasteInto(page: Page, label: string, text: string): Promise<void> {
  const field = page.getByRole('textbox', { name: label })
  await field.focus()
  await field.evaluate((element, value) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', value)
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
    )
  }, text)
}

const BLOCK = [
  'One: the opening of the run.',
  'Two: the middle of the run.',
  'Three: the end of the run.',
].join('\n\n')

test(
  'a pasted block becomes separate posts, scheduled as one run and edited from the queue',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x'] })
    await weeklySlots(page)
    await page.goto('/publish')

    await page.getByTestId('new-draft').first().click()
    await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
    await pasteInto(page, 'New draft text', BLOCK)

    // Each piece is listed with its length before anything is created.
    const split = page.getByTestId('paste-split')
    await expect(split).toContainText('separates into 3 pieces')
    await expect(page.getByTestId('paste-piece-1')).toContainText('One: the opening of the run.')
    await expect(page.getByTestId('paste-piece-3')).toContainText('26')

    await page.getByRole('textbox', { name: 'Series name' }).fill('Storytelling')
    await page.getByTestId('paste-make-posts').click()

    // Three drafts, and the library's series scheduler open on exactly those.
    await page.waitForURL(/\/publish(\?|$)/)
    const scheduler = page.getByRole('dialog', { name: 'Schedule 3 drafts' })
    await expect(scheduler).toBeVisible({ timeout: 60_000 })
    await expect
      .poll(async () =>
        (
          await db.rows<{ title: string }>(
            `SELECT title FROM content_draft
              WHERE "organizationId" = $1 AND title LIKE 'Storytelling%' ORDER BY title`,
            [workspace.id]
          )
        ).map((row) => row.title)
      )
      .toEqual(['Storytelling · 1/3', 'Storytelling · 2/3', 'Storytelling · 3/3'])

    // All three on one day, so the run is easy to read back in the queue.
    await scheduler.getByRole('spinbutton', { name: 'Posts per day' }).fill('3')
    // Preview every time first, then confirm: one step for the whole run.
    await scheduler.getByRole('button', { name: 'Preview and validate' }).click()
    await scheduler.getByRole('button', { name: /^Schedule valid drafts \(3\)$/ }).click()
    await expect
      .poll(
        async () =>
          (
            await db.rows<{ count: string }>(
              `SELECT count(*)::text AS count FROM scheduled_post p
                 JOIN content_draft d ON d.id = p."contentDraftId"
                WHERE d."organizationId" = $1 AND d.title LIKE 'Storytelling%' AND p.status = 'SCHEDULED'`,
              [workspace.id]
            )
          )[0]?.count,
        { timeout: 60_000 }
      )
      .toBe('3')

    // The queue gathers the run under its name and counts what is scheduled.
    await page.goto('/publish?tab=queue')
    const queue = page.getByTestId('queue')
    await expect(queue.getByTestId('queue-goal')).toContainText('3 posts scheduled')
    const group = queue.getByTestId('queue-group').first()
    await expect(group).toContainText('Storytelling')
    await expect(group).toContainText('3 posts')

    // Selecting the run moves all of it at once.
    const before = await db.rows<{ at: string }>(
      `SELECT "scheduledFor"::text AS at FROM scheduled_post p
         JOIN content_draft d ON d.id = p."contentDraftId"
        WHERE d."organizationId" = $1 AND d.title LIKE 'Storytelling%' ORDER BY p."scheduledFor"`,
      [workspace.id]
    )
    await group.getByRole('button', { name: 'Select the run' }).click()
    const bar = page.getByTestId('queue-bulk-bar')
    await expect(bar).toContainText('3 selected')
    await bar.getByRole('button', { name: 'Later', exact: true }).click()
    await expect
      .poll(
        async () =>
          (
            await db.rows<{ at: string }>(
              `SELECT "scheduledFor"::text AS at FROM scheduled_post p
                 JOIN content_draft d ON d.id = p."contentDraftId"
                WHERE d."organizationId" = $1 AND d.title LIKE 'Storytelling%' ORDER BY p."scheduledFor"`,
              [workspace.id]
            )
          ).map((row) => row.at),
        { timeout: 60_000 }
      )
      .not.toEqual(before.map((row) => row.at))
  }
)

test(
  'Schedule and next queues the post and opens the next draft on the same accounts',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await weeklySlots(page)
    await page.goto('/publish')

    await page.getByTestId('new-draft').first().click()
    await page.keyboard.type('The first post of the run.')
    await page.waitForURL(/\/publish\/[a-z0-9]+/)
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    const first = new URL(page.url()).pathname.split('/').pop() ?? ''

    // Only X: the next draft must open on that choice, not on the brand's defaults.
    await page.getByRole('switch', { name: 'Publish to Bluesky', exact: true }).click()
    await expectSaved(page)

    const dock = page.getByTestId('schedule-dock')
    await dock.getByRole('textbox', { name: 'Schedule time in words' }).fill('+3h')
    await dock.getByTestId('dock-schedule-next-button').click()
    // The next post opens blank on X alone, and its first word makes the draft.
    const blank = page.getByRole('region', { name: 'New post' })
    await expect(blank.getByTestId('destination-summary')).toContainText('X')
    await expect(blank.getByTestId('destination-summary')).not.toContainText('Bluesky')
    await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
    await page.keyboard.type('The second post of the run.')

    await page.waitForURL(
      (url) => /\/publish\/[a-z0-9]+/.test(url.pathname) && !url.pathname.endsWith(first),
      {
        timeout: 60_000,
      }
    )
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByRole('switch', { name: 'Publish to X', exact: true })).toBeChecked()
    await expect(
      page.getByRole('switch', { name: 'Publish to Bluesky', exact: true })
    ).not.toBeChecked()

    // The first post is queued, and the new draft opens after it, not tomorrow at 9.
    const queued = await db.rows<{ at: string }>(
      `SELECT "scheduledFor"::text AS at FROM scheduled_post WHERE "contentDraftId" = $1`,
      [first]
    )
    expect(queued).toHaveLength(1)
    await expect(page.getByTestId('dock-schedule-button')).toContainText('Schedule for')
  }
)

test(
  'Save draft & new writes independent drafts on the same accounts and schedules nothing',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    // Bluesky first, so the brand's main platform is not X: the next drafts must not open on it.
    const workspace = await startWorkspace({ channels: ['bluesky', 'x'] })
    await page.goto('/publish')

    // New draft opens the blank post in place, focused, with no dialog.
    await page.getByTestId('new-draft').first().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
    await page.keyboard.type('First independent post.')
    await page.waitForURL(/\/publish\/[a-z0-9]+/)
    await expect(draftEditor(page)).toContainText('First independent post.', { timeout: 60_000 })
    await page.getByRole('switch', { name: 'Publish to Bluesky', exact: true }).click()
    await expectSaved(page)
    await expect(page.getByTestId('writing-bar')).toContainText('@shots_x')
    await expect(page.getByTestId('writing-bar')).not.toContainText('Bluesky')
    // A last edit is saved by Save draft & new itself, not left to the autosave.
    await page.getByRole('textbox', { name: 'Draft title', exact: true }).fill('Run, part one')

    const ids = [new URL(page.url()).pathname.split('/').pop() ?? '']
    for (const [text, start] of [
      ['Second independent post.', 'button'],
      ['Third independent post.', 'rail'],
    ] as const) {
      // The rail's New draft, with a draft open, is the same action as the button.
      if (start === 'button')
        await page.getByRole('button', { name: 'Save draft & new', exact: true }).click()
      else await page.getByTestId('new-draft').first().click()
      const blank = page.getByRole('region', { name: 'New post' })
      await expect(blank.getByTestId('destination-summary')).toContainText('@shots_x')
      await expect(blank.getByTestId('destination-summary')).not.toContainText('Bluesky')
      await expect(blank.getByTestId('post-length-1')).toHaveText('0 / 280')
      await expect(page.getByRole('textbox', { name: 'New draft text' })).toBeFocused()
      await page.keyboard.type(text)
      await page.waitForURL(
        (url) =>
          /\/publish\/[a-z0-9]+/.test(url.pathname) &&
          !ids.includes(url.pathname.split('/').pop() ?? '')
      )
      await expect(draftEditor(page)).toContainText(text, { timeout: 60_000 })
      await expectSaved(page)
      ids.push(new URL(page.url()).pathname.split('/').pop() ?? '')
    }

    const drafts = await db.rows<{
      channels: string[]
      primary: string
      text: string
      title: string
    }>(
      `SELECT "channelConnectionIds" AS channels, "primaryPlatform" AS primary, "plainText" AS text, title
         FROM content_draft WHERE "organizationId" = $1 ORDER BY "createdAt"`,
      [workspace.id]
    )
    expect(drafts[0]!.title).toBe('Run, part one')
    expect(drafts.map((draft) => draft.text)).toEqual([
      'First independent post.',
      'Second independent post.',
      'Third independent post.',
    ])
    for (const draft of drafts.slice(1)) {
      expect(draft.channels).toEqual([workspace.channels.x])
      expect(draft.primary).toBe('x')
    }
    expect(
      await db.rows(
        `SELECT p.id FROM scheduled_post p JOIN content_draft d ON d.id = p."contentDraftId" WHERE d."organizationId" = $1`,
        [workspace.id]
      )
    ).toHaveLength(0)
  }
)

test(
  'an unused blank post leaves nothing behind, whether discarded or left',
  { tag: '@journey' },
  async ({ page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x'] })
    let creations = 0
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname === '/api/v1/content-drafts'
      )
        creations++
    })
    await page.goto('/publish')
    const blank = page.getByRole('region', { name: 'New post' })

    await page.getByTestId('new-draft').first().click()
    await expect(blank).toBeVisible()
    await blank.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(blank).toHaveCount(0)

    await page.getByTestId('new-draft').first().click()
    await expect(blank).toBeVisible()
    await page
      .getByRole('complementary', { name: 'Primary navigation' })
      .getByRole('link', { name: 'Calendar', exact: true })
      .click()
    await page.waitForURL(/\/publish\/calendar/)
    await expect(blank).toHaveCount(0)

    expect(creations).toBe(0)
    expect(
      await db.rows(`SELECT id FROM content_draft WHERE "organizationId" = $1`, [workspace.id])
    ).toHaveLength(0)
  }
)

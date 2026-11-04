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

/** Every day at 09:00 and 18:00 in New York, so the next seven days have free slots. */
async function weeklySlots(page: Page): Promise<string> {
  const sets = await apiRequest(page, '/api/v1/social-sets')
  const [set] = (sets.body as { items: { id: string; name: string; version: number }[] }).items
  const saved = await apiRequest(page, `/api/v1/social-sets/${set.id}`, {
    method: 'PATCH',
    body: {
      baseVersion: set.version,
      name: set.name,
      postingSlots: [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { time: '09:00', weekday },
        { time: '18:00', weekday },
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
  async ({ page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'bluesky'] })
    await weeklySlots(page)
    const id = await openNewDraft(page)
    // Nothing that asks for input sits between the header and the first post.
    const between = await page.evaluate(() => {
      const header = document.querySelector('[data-testid="write-composer"] header')
      const body = document.querySelector('[data-testid="composer-body"] [contenteditable="true"]')
      if (!header || !body) return { controls: -1, top: -1 }
      const top = header.getBoundingClientRect().bottom
      const bottom = body.getBoundingClientRect().top
      const controls = [
        ...document.querySelectorAll(
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
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect
      .poll(async () => (await draftPosts(id)).map((post) => post.status))
      .toEqual(['CANCELLED', 'CANCELLED'])
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
    await failed.getByText('Details', { exact: true }).click()
    await expect(failed.getByTestId('failure-details')).toContainText('ACCOUNT_RECONNECT')
    await page.screenshot({ path: '.context/shots/publish-failure-1440.png', fullPage: true })
    // The drafts list reads the same words.
    await page.goto('/write')
    await expect(page.getByTestId('write-rail')).toContainText('Failed · 1 of 2')
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
    await page.getByTestId('blockers-button').click()
    const blockers = page.getByTestId('blockers')
    await expect(blockers).toContainText('X: 290 of 280 characters')
    await blockers.getByRole('button', { name: /^X: 290 of 280/ }).click()
    await expect(page.getByTestId('platform-tab-x')).toHaveAttribute('aria-selected', 'true')

    await page.getByRole('button', { name: 'Add another post' }).click()
    await expect(page.getByTestId('empty-post-2')).toContainText('Empty, not sent')
    await page.getByRole('button', { name: 'Remove empty post' }).click()
    await expect(page.getByTestId('post-header')).toHaveCount(1)

    await page.goto('/write?tab=queue')
    const queue = page.getByTestId('queue')
    await expect(queue.getByTestId('queue-goal')).toContainText('slots filled this week')
    await expect(queue.getByRole('link', { name: 'Edit schedule' })).toBeVisible()
    const slot = queue.getByTestId('queue-free-slot').first()
    await expect(slot).toBeVisible()
    await page.screenshot({ path: '.context/shots/publish-queue-1440.png' })
    await slot.getByRole('button', { name: '+ New' }).click()
    await page.waitForURL(/day=\d{4}-\d{2}-\d{2}&time=\d{2}:\d{2}/)
    const time = new URL(page.url()).searchParams.get('time') ?? ''
    await expect(draftEditor(page)).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('schedule-button').click()
    await expect(page.getByLabel('Time', { exact: true })).toHaveValue(time)
  }
)

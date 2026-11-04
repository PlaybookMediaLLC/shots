import {
  apiRequest,
  chooseChannels,
  db,
  draftEditor,
  expect,
  expectSaved,
  inPreview,
  openNewDraft,
  openSchedule,
  type Page,
  previewOf,
  settleSelection,
  test,
} from './framework'
import { format } from 'date-fns'

// RFC 013, round two: the posting surface around the composer. Posts are
// scheduled for later and live state is set in the database, so nothing is
// published to a network.

type PostRow = {
  assetIds: unknown
  autoActions: unknown
  caption: string
  id: string
  poll: unknown
  replies: unknown
  replyTo: string | null
  scheduledFor: Date
  status: string
}

async function draftPosts(draftId: string): Promise<PostRow[]> {
  return await db.rows<PostRow>(
    `SELECT id, caption, status::text AS status, ("scheduledFor" AT TIME ZONE 'UTC') AS "scheduledFor",
              "assetIds", replies, "replyTo",
              "autoActions", poll
       FROM scheduled_post WHERE "contentDraftId" = $1 ORDER BY "createdAt"`,
    [draftId]
  )
}

async function write(page: Page, text: string): Promise<void> {
  await draftEditor(page).click()
  await page.keyboard.type(text)
  await expectSaved(page)
}

/**
 * Repeats `act` until it sends a POST to a path ending in `suffix`. On a cold
 * route the markup paints before React hydrates, and an early drag or click
 * is dropped silently (a form even submits natively), so the request itself
 * is the proof the action landed.
 */
async function untilPosted(page: Page, suffix: string, act: () => Promise<void>): Promise<void> {
  let sent = false
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(suffix)) {
      sent = true
    }
  })
  await expect(async () => {
    if (!sent) await act()
    await expect.poll(() => sent, { timeout: 2_000 }).toBe(true)
  }).toPass({ timeout: 60_000 })
}

test(
  'the queue takes the next slot, and the calendar moves a post to another day',
  { tag: ['@journey', '@smoke'] },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })

    // The account shows as its platform names it, not an integration id.
    const draftId = await openNewDraft(page)
    await page.getByRole('button', { name: 'Manage platforms' }).click()
    await expect(page.getByRole('dialog')).toContainText('@shots_x')
    await page.keyboard.press('Escape')
    await write(page, 'Queued for the next slot')
    await chooseChannels(page, ['x'])
    await expectSaved(page)

    const dialog = await openSchedule(page)
    await dialog.getByText('More options', { exact: true }).click()
    await expect(dialog.getByText('Suggested times', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Next free slot' }).click()
    // Stay on this draft; scheduling opens a new one by default.
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: 'Add to queue', exact: true }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1, { timeout: 30_000 })
    const [queued] = await draftPosts(draftId)
    // The default slots: weekdays at 9:00 in the workspace's time zone.
    expect(queued.status).toBe('SCHEDULED')
    const { timeZone } = (await apiRequest(page, '/api/v1/content-draft-settings')).body as {
      timeZone: string
    }
    const inZone = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(
        new Date(queued.scheduledFor)
      )
    expect(inZone({ hour: 'numeric', hourCycle: 'h23', minute: '2-digit' })).toBe('09:00')
    expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(inZone({ weekday: 'short' }))

    await page.getByRole('tab', { name: /Queue/ }).click()
    await expect(page.getByTestId('queue-item')).toContainText('Queued for the next slot')

    // A second draft at a set time, moved on the calendar by a day.
    const second = await openNewDraft(page)
    await write(page, 'Moved on the calendar')
    await chooseChannels(page, ['x'])
    await expectSaved(page)
    const at = new Date(Date.now() + 3 * 86_400_000)
    at.setHours(10, 0, 0, 0)
    const pad = (value: number) => String(value).padStart(2, '0')
    const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T10:00`
    const scheduleDialog = await openSchedule(page)
    await scheduleDialog.getByLabel('Day', { exact: true }).click()
    // react-day-picker names each day button with its full date.
    const nextMonth = page.getByRole('button', { name: 'Go to the Next Month' })
    await expect(nextMonth).toBeVisible()
    const dayButton = page.getByRole('button', { name: format(at, 'PPPP') })
    if (!(await dayButton.isVisible())) await nextMonth.click()
    await dayButton.click()
    await scheduleDialog.getByLabel('Time', { exact: true }).fill(local.slice(11))
    await scheduleDialog.getByLabel('Open a new draft after scheduling').uncheck()
    await scheduleDialog.getByRole('button', { name: 'Confirm schedule' }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1, { timeout: 30_000 })

    await app.open(`/publish/calendar?week=${local.slice(0, 10)}`)
    const card = page
      .getByTestId('calendar-post')
      .filter({ hasText: 'Moved on the calendar', visible: true })
    await expect(card).toBeVisible()
    // The next day, or the day before when it is the week's last.
    const target = new Date(at)
    target.setDate(at.getDate() + (at.getDay() === 0 ? -1 : 1))
    await untilPosted(page, '/calendar/mutations', () =>
      card.dragTo(page.getByTestId(`calendar-day-${target.getDate()}`))
    )
    await expect(page.getByText('Calendar updated.', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    const posts = await draftPosts(second)
    expect(posts.map((post) => post.status)).toEqual(['CANCELLED', 'SCHEDULED'])
    expect(new Date(posts[1].scheduledFor).getDate()).toBe(target.getDate())
  }
)

test(
  'a draft waits for approval, and an edit after approval needs another',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })

    await app.open('/publish')
    await page
      .getByTestId('write-rail')
      .getByRole('link', { name: 'Settings', exact: true })
      .click()
    await page.getByLabel('Require approval').check()
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(page.getByText('Saved.')).toBeVisible()

    const draftId = await openNewDraft(page)
    await write(page, 'Needs a second pair of eyes')
    await chooseChannels(page, ['x'])
    await expectSaved(page)
    const blocked = await openSchedule(page)
    await expect(blocked.getByTestId('blocking-problems')).toContainText('approves drafts')
    await expect(blocked.getByRole('button', { name: 'Confirm schedule' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(blocked).toBeHidden()

    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: 'Ask for review' }).click()
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toContainText(
      'In review'
    )
    // A publisher (here the owner) answers from the same control.
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await page.getByLabel('Review note').fill('Ship it')
    await page.getByRole('button', { name: 'Approve' }).click()
    await expect(page.getByRole('button', { name: 'Review', exact: true })).toContainText(
      'Approved'
    )
    await page.keyboard.press('Escape')

    const dialog = await openSchedule(page)
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: 'Confirm schedule' }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(1, { timeout: 30_000 })
    expect(await draftPosts(draftId)).toHaveLength(1)
  }
)

test(
  'a share link lets a guest read the draft and leave a comment',
  { tag: '@journey' },
  async ({ browser, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x'] })

    await openNewDraft(page)
    await write(page, 'What do you think of this launch post?')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    const share = page.getByTestId('share-dialog')
    // The switch follows the server: it turns on once the link exists.
    await share.getByLabel('Public link', { exact: true }).click()
    await expect(share.getByLabel('Public link to share')).toBeVisible()
    const link = await share.getByLabel('Public link to share').inputValue()
    expect(link).toMatch(/\/d\/[A-Za-z0-9_-]{30,}$/)
    await page.keyboard.press('Escape')

    const guest = await browser.newContext()
    try {
      const guestPage = await guest.newPage()
      await guestPage.goto(link)
      await expect(guestPage.getByTestId('shared-draft')).toContainText(
        'What do you think of this launch post?'
      )
      await untilPosted(guestPage, '/comments', async () => {
        await guestPage.getByLabel('Your name').fill('Ana')
        await guestPage.getByLabel('Your comment').fill('Lead with the price.')
        await guestPage.getByRole('button', { name: 'Send comment' }).click()
      })
      // In the list, not just still in the box: the comment was kept.
      await expect(
        guestPage.getByRole('listitem').filter({ hasText: 'Lead with the price.' })
      ).toBeVisible({ timeout: 60_000 })
    } finally {
      await guest.close()
    }

    // A shared draft renders on the server too.
    expect((await page.goto(page.url()))?.status()).toBe(200)
    await page.getByRole('button', { name: 'Comments', exact: true }).click()
    await expect(page.getByTestId('guest-comments')).toContainText('Lead with the price.')
    // Off, the link finds nothing.
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await share.getByLabel('Public link', { exact: true }).click()
    await expect(share.getByLabel('Public link to share')).toHaveCount(0)
    await page.keyboard.press('Escape')
    const offline = await browser.newContext()
    try {
      const response = await (await offline.newPage()).goto(link)
      expect(response?.status()).toBe(404)
    } finally {
      await offline.close()
    }
  }
)

test(
  'writing tools: history, per-post tools, channel text, AI, hashtags and plain-language times',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, page, startWorkspace }) => {
    await startWorkspace({ channels: ['x', 'linkedin'] })

    // A first draft teaches the composer a hashtag.
    await openNewDraft(page)
    await write(page, 'Launch week #shipit')
    const draftId = await openNewDraft(page)
    await draftEditor(page).click()
    await page.getByRole('button', { name: '#shipit' }).click()
    await expect(draftEditor(page)).toContainText('#shipit')
    await page.keyboard.type(' First post')
    await settleSelection(page)
    await page.keyboard.press('ControlOrMeta+Enter')
    await settleSelection(page)
    await page.keyboard.type('Second post')
    await expectSaved(page)
    await expect(page.getByTestId('post-header')).toHaveCount(2)

    // Per-post tools: the second post moves up, then is deleted.
    await page.getByTestId('post-header').nth(1).hover()
    await page.getByRole('button', { name: 'Move post 2 up' }).click()
    // Still two posts, now in the other order.
    await expect(page.getByTestId('post-header')).toHaveCount(2)
    // Each post's header (account, length) sits inside the editor, before its text.
    await expect(draftEditor(page)).toHaveText(/Second post[\s\S]*#shipit First post$/)
    await page.getByTestId('post-header').nth(1).hover()
    await page.getByRole('button', { name: 'Delete post 2' }).click()
    await expect(page.getByTestId('post-header')).toHaveCount(1)
    await expect(draftEditor(page)).not.toContainText('First post')
    await expectSaved(page)

    // Backups: the saves so far were kept. Recovering one makes a new draft
    // that holds it; the draft itself is left as it is.
    await page.getByRole('button', { name: 'More draft actions' }).click()
    await page.getByRole('menuitem', { name: 'View automatic backups' }).click()
    const backups = page.getByTestId('backups-browser')
    await expect(backups.getByTestId('backup-time')).toBeVisible({ timeout: 60_000 })
    await backups.getByRole('button', { name: 'Create new draft from this version' }).click()
    await page.waitForURL(
      (url) => !url.pathname.endsWith(draftId) && /\/publish\/[a-z0-9]+/.test(url.pathname)
    )
    await expect(draftEditor(page)).toContainText('#shipit', { timeout: 60_000 })
    await app.open(`/publish/${draftId}`)
    await expect(draftEditor(page)).toContainText('Second post', { timeout: 60_000 })

    // Channel text: LinkedIn says something longer, in its own version.
    await chooseChannels(page, ['x', 'linkedin'])
    await page.getByTestId('platform-tab-linkedin').click()
    await page.getByRole('button', { name: 'Edit for LinkedIn independently' }).click()
    await expect(page.getByTestId('manual-version-linkedin')).toBeVisible()
    // Over the forked text, past slate's selection sync.
    await draftEditor(page).getByText('Second post', { exact: true }).selectText()
    await settleSelection(page)
    await page.keyboard.type('A longer note for LinkedIn readers.')
    await expect(page.getByTestId('platform-tab-linkedin')).toContainText('Own text')
    await inPreview(page, async () => {
      await expect(await previewOf(page, 'linkedin')).toContainText(
        'A longer note for LinkedIn readers.'
      )
    })
    await expectSaved(page)

    // AI: the scripted model answers, Accept puts the answer in, and Undo takes it back.
    await page.getByTestId('platform-tab-x').click()
    await page.getByRole('button', { name: 'Rewrite', exact: true }).click()
    await page
      .getByTestId('refine-menu')
      .getByRole('button', { name: 'Rewrite as a thread start' })
      .click()
    const review = page.getByTestId('refine-review')
    await expect(review).toContainText('(refined)', { timeout: 60_000 })
    await review.getByRole('button', { name: 'Accept' }).click()
    await expect(draftEditor(page)).toContainText('(refined)')
    await page.keyboard.press('ControlOrMeta+z')
    await expect(draftEditor(page)).not.toContainText('(refined)')
    await expectSaved(page)

    // An X poll on the first post.
    await page.getByRole('button', { name: 'Add a poll' }).click()
    await page.getByRole('button', { name: 'Add poll', exact: true }).click()
    await page.getByLabel('Poll option 1').fill('Yes')
    await page.getByLabel('Poll option 2').fill('No')
    await page.keyboard.press('Escape')
    await expectSaved(page)

    // Plain-language time and an X follow-up, then scheduling.
    const dialog = await openSchedule(page)
    // Times are read in the set's zone, which the dialog names.
    const zone = /Times are in (\S+) /.exec(
      (await dialog.getByText(/^Times are in /).textContent()) ?? ''
    )?.[1]
    await dialog.getByText('More options', { exact: true }).click()
    await dialog.getByLabel('When, in words').fill('tomorrow 9am')
    await expect(dialog.getByTestId('when-reading')).toContainText('9:00')
    await dialog.getByRole('switch', { name: 'Auto-Plug' }).click()
    const plug = page.getByTestId('auto-plug-dialog')
    await plug.getByLabel('Threshold').fill('25')
    await plug.getByLabel('Plug reply').fill('The full guide is on our blog.')
    await plug.getByRole('button', { name: 'Enable Auto-Plug' }).click()
    await expect(dialog.getByTestId('automation-auto-plug')).toContainText('At 25 likes')
    await dialog.getByLabel('Open a new draft after scheduling').uncheck()
    await dialog.getByRole('button', { name: 'Confirm schedule' }).click()
    await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 30_000 })
    const posts = await draftPosts(draftId)
    const linkedin = posts.find((post) => post.caption === 'A longer note for LinkedIn readers.')
    const x = posts.find((post) => post !== linkedin)
    expect(linkedin).toBeDefined()
    expect(x?.poll).toEqual({ durationMinutes: 1440, options: ['Yes', 'No'] })
    expect(x?.autoActions).toEqual({
      plugAtLikes: 25,
      plugMetric: 'likes',
      plugText: 'The full guide is on our blog.',
    })
    expect(
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hourCycle: 'h23',
        minute: '2-digit',
        timeZone: zone,
      }).format(new Date(x?.scheduledFor ?? 0))
    ).toBe('09:00')
  }
)

test('a live post links to itself, shows engagement, and resumes a thread that stopped', async ({
  app,
  page,
  startWorkspace,
}) => {
  await startWorkspace({ channels: ['x'] })

  const draftId = await openNewDraft(page)
  await write(page, 'One')
  await page.keyboard.press('ControlOrMeta+Enter')
  await settleSelection(page)
  await page.keyboard.type('Two')
  await page.keyboard.press('ControlOrMeta+Enter')
  await settleSelection(page)
  await page.keyboard.type('Three')
  await chooseChannels(page, ['x'])
  await expectSaved(page)
  const dialog = await openSchedule(page)
  await dialog.getByLabel('Open a new draft after scheduling').uncheck()
  await dialog.getByRole('button', { name: 'Confirm schedule' }).click()
  await expect(page.getByTestId('draft-post')).toHaveCount(1, { timeout: 30_000 })

  // As the publisher leaves it when the second reply failed.
  const [post] = await draftPosts(draftId)
  await db.row(
    `UPDATE scheduled_post SET status = 'PUBLISHED', "remotePostId" = 'tweet-1',
           "threadProgress" = '{"posted":1,"total":2,"lastReplyId":"tweet-2"}'::jsonb,
           metrics = '{"likes":12,"reposts":3}'::jsonb, "metricsAt" = now()
         WHERE id = $1 RETURNING id`,
    [post.id]
  )
  await app.reload()
  const live = page.getByTestId('draft-post')
  await expect(live.getByRole('link', { name: 'View post' })).toHaveAttribute(
    'href',
    'https://x.com/i/status/tweet-1'
  )
  await expect(live.getByTestId('metric-likes')).toContainText('12')
  await expect(live).toContainText('1 of 2 replies went out.')
  // The reloaded page renders the button before React attaches its handler, so
  // an early click is dropped. A handled click disables it until the resume
  // returns, which a cold dev server compiles first; only an idle button is retried.
  const resume = live.getByRole('button', { name: 'Post the rest' })
  await expect(async () => {
    if ((await page.getByTestId('draft-post').count()) < 2 && (await resume.isEnabled())) {
      await resume.click()
    }
    await expect(page.getByTestId('draft-post')).toHaveCount(2, { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  const posts = await draftPosts(draftId)
  // It goes out now: here, with no real account behind the channel, it fails.
  expect(posts[1]).toMatchObject({ caption: 'Three', replyTo: 'tweet-2' })
  expect(posts[1].status).not.toBe('CANCELLED')

  // The rail's Posted tab lists the draft.
  await page.getByRole('tab', { name: /Posted/ }).click()
  await expect(page.getByRole('navigation').getByText('1 live', { exact: false })).toBeVisible()
  expect((await apiRequest(page, `/api/v1/content-drafts/${draftId}/revisions`)).status).toBe(200)
})

test('on a phone, a comment opens beside its text', async ({ page, startWorkspace }) => {
  await startWorkspace({ channels: ['x'] })

  await page.setViewportSize({ height: 844, width: 390 })
  await openNewDraft(page)
  await draftEditor(page).click()
  await page.keyboard.type('Launch day')
  await draftEditor(page).getByText('Launch day', { exact: true }).selectText()
  await settleSelection(page)
  // A phone has no selection toolbar: the shortcut starts the comment.
  await page.keyboard.press('ControlOrMeta+Shift+M')
  const reply = page.getByText('Reply...')
  await expect(reply).toBeInViewport()
  // Not pinned to the window's corner.
  const box = await reply.boundingBox()
  expect(box?.y ?? 0).toBeGreaterThan(80)
})

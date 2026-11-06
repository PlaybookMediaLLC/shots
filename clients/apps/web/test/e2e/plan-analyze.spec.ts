import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { format } from 'date-fns'
import { apiRequest, chooseOption, db, enableDraftTags, expect, test } from './framework'

test.use({ actionTimeout: 30000 })

test('Plan acceptance: authenticated account selection, creation, lifecycle, movement and responsive controls', async ({
  app,
  page,
  startWorkspace,
}) => {
  test.setTimeout(360_000)
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
  await enableDraftTags(page)
  const all = await apiRequest(page, '/api/v1/social-sets')
  expect(all.status, JSON.stringify(all.body)).toBe(200)
  const sets = (all.body as { items: { id: string; version: number; name: string }[] }).items
  const first = sets[0]
  // The planned day: three days out, so it is never past, but never a month's last day.
  // Later steps move it a day, and the month view opened on this day must still contain it.
  const daysAhead = (count: number) =>
    new Date(Date.now() + count * 86400000).toISOString().slice(0, 10)
  const day = daysAhead(3).slice(0, 7) === daysAhead(4).slice(0, 7) ? daysAhead(3) : daysAhead(4)
  expect(
    (
      await apiRequest(page, `/api/v1/social-sets/${first.id}`, {
        method: 'PATCH',
        body: {
          baseVersion: first.version,
          name: 'Same name',
          timeZone: 'America/New_York',
          // The slot falls on the planned day, so it is never already past.
          postingSlots: [{ weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), time: '09:15' }],
        },
      })
    ).status
  ).toBe(200)
  const createdSet = await apiRequest(page, '/api/v1/social-sets', {
    method: 'POST',
    body: { name: 'Same name', timeZone: 'Asia/Tokyo' },
  })
  expect(createdSet.status, JSON.stringify(createdSet.body)).toBe(201)
  const second = createdSet.body as { id: string }
  await db.query(
    'UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2 AND "organizationId"=$3',
    [second.id, workspace.channels.linkedin, workspace.id]
  )
  const sourceDraft = await apiRequest(page, '/api/v1/content-drafts', {
    method: 'POST',
    body: {
      socialSetId: first.id,
      plainText: 'Picker source draft',
      body: [{ type: 'p', children: [{ text: 'Picker source draft' }] }],
    },
  })
  expect(sourceDraft.status, JSON.stringify(sourceDraft.body)).toBe(201)
  const sourceId = (sourceDraft.body as { id: string }).id
  await app.open(`/publish/calendar?day=${day}`)
  await test.step('P01 Calendar retains shared Publish navigation', async () => {
    await expect(page.getByRole('link', { name: 'Analyze', exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Posts', exact: true }).first()).toBeVisible()
  })
  await test.step('P02 same-named provider identities are distinguishable', async () => {
    await expect(
      page.getByRole('checkbox', { name: 'Show Same name X', exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole('checkbox', { name: 'Show Same name LinkedIn', exact: true })
    ).toBeVisible()
  })
  await test.step('P03 P05 P06 all mixed and none selection use stable account IDs', async () => {
    const all = page.getByRole('checkbox', { name: 'All profiles' })
    await expect(all).toBeChecked()
    await page.getByRole('checkbox', { name: 'Show Same name LinkedIn', exact: true }).uncheck()
    await expect(all).toBeChecked({ indeterminate: true })
    await page.getByRole('checkbox', { name: 'Show Same name X', exact: true }).uncheck()
    await expect(all).not.toBeChecked()
    await all.check()
  })
  await test.step('P04 P19 P20 P21 single focus controls available slots independently', async () => {
    await page.getByRole('button', { name: 'Show only', exact: true }).first().click()
    await page.getByText('Display', { exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Show empty slots' })).toBeVisible()
    await page.getByText('Display', { exact: true }).click()
    await expect(page.getByTestId('available-slot').first()).toContainText('Available')
    await expect(page.getByTestId('available-slot').first()).not.toHaveAttribute(
      'draggable',
      'true'
    )
    await page.getByTestId('available-slot').first().click()
    await expect(page.getByRole('dialog').getByTestId('schedule-zone')).toContainText('New York')
    await expect(page.getByLabel('Time', { exact: true })).toHaveValue('9:15 AM')
    await page.keyboard.press('Escape')
    await chooseOption(page.getByLabel('Calendar view'), 'Week')
    await expect(page.getByTestId('available-slot').first()).toBeVisible()
    await expect(page.getByTestId('available-slot').first().locator('..')).toHaveCSS(
      'position',
      'absolute'
    )
    await chooseOption(page.getByLabel('Calendar view'), 'Month')
    await page.getByRole('button', { name: 'Show all accounts' }).click()
    await page.getByText('Display', { exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Show empty slots' })).toHaveCount(0)
    await page.getByText('Display', { exact: true }).click()
  })
  await test.step('P07 P08 P09 draft sidebar retains the view and date anchor', async () => {
    await chooseOption(page.getByRole('combobox', { name: 'Calendar view' }), 'Month')
    await page.getByRole('button', { name: 'Drafts', exact: true }).first().click()
    await expect(page.getByRole('link', { name: /Picker source draft.*x.*Edited/ })).toBeVisible()
    await page.getByRole('button', { name: 'Posted', exact: true }).click()
    await expect(page.getByRole('link', { name: /Picker source draft/ })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Calendar view' })).toContainText('Month')
    await page.getByRole('button', { name: 'Back to profiles' }).click()
  })
  await test.step('P10 P11 P12 P13 P14 P15 view controls and keyboard keep a usable period', async () => {
    await chooseOption(page.getByRole('combobox', { name: 'Calendar view' }), 'Week')
    await expect(page.getByRole('button', { name: '12:00 AM', exact: true })).toHaveCount(7)
    // CAL-01: today's badge must not move its hour grid off the other days'.
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(page.locator('time[aria-current="date"]')).toBeVisible()
    const midnights = await page
      .getByRole('button', { name: '12:00 AM', exact: true })
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top))
    expect(new Set(midnights).size, midnights.join(', ')).toBe(1)
    await page.keyboard.press('m')
    await expect(page.getByRole('combobox', { name: 'Calendar view' })).toContainText('Month')
    await page.getByRole('button', { name: 'Next month', exact: true }).click()
    await page.getByRole('button', { name: 'Previous month', exact: true }).click()
  })
  await test.step('P10 Flex resizes its rendered weeks with the actual viewport', async () => {
    await chooseOption(page.getByLabel('Calendar view'), 'Flex')
    const initial = await page.locator('[data-calendar-date]').count()
    await page.setViewportSize({ width: 1280, height: 1100 })
    await expect.poll(() => page.locator('[data-calendar-date]').count()).toBeGreaterThan(initial)
    await page.setViewportSize({ width: 1280, height: 720 })
    await chooseOption(page.getByLabel('Calendar view'), 'Month')
  })
  await test.step('P15 Today restores the current period and P11 marks the exact display day', async () => {
    await page.getByRole('button', { name: 'Next month', exact: true }).click()
    await page.getByRole('button', { name: 'Today', exact: true }).click()
    await expect(page.locator('time[aria-current="date"]')).toHaveCount(1)
    // Near a month's end the planned day is in the next month, which later steps need.
    const today = await page.locator('time[aria-current="date"]').getAttribute('datetime')
    if (today?.slice(0, 7) !== day.slice(0, 7))
      await page.getByRole('button', { name: 'Next month', exact: true }).click()
  })
  await test.step('P27 P28 P29 picker search and distinct source tabs cancel without a commit', async () => {
    await page.getByRole('button', { name: `Create draft ${day}`, exact: true }).click()
    await page.getByRole('button', { name: 'Choose existing content' }).click()
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Review and schedule…', exact: true })
    ).toBeDisabled()
    await page.getByLabel('Search existing content').fill('no matching draft')
    await expect(page.getByText('No content matches.', { exact: true })).toBeVisible()
    await page.getByLabel('Search existing content').fill('Picker source')
    await page.getByRole('button', { name: /Picker source draft/ }).click()
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeEnabled()
    await expect(
      page.getByRole('button', { name: 'Review and schedule…', exact: true })
    ).toBeEnabled()
    await page.getByRole('button', { name: 'Published', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Plan', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Close', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Plan a draft' })).toBeVisible()
    await page.keyboard.press('Escape')
    const draft = await apiRequest(page, `/api/v1/content-drafts/${sourceId}`)
    expect((draft.body as { plannedFor: unknown }).plannedFor).toBeNull()
    expect((await apiRequest(page, `/api/v1/content-drafts/${sourceId}/posts`)).body).toMatchObject(
      { posts: [] }
    )
  })
  await test.step('P24 P25 P26 P29 P30 P31 P32 quick composer validates and cancels without creating content', async () => {
    await page.getByRole('button', { name: `Create draft ${day}`, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toContainText(
      format(new Date(`${day}T12:00`), 'PP')
    )
    await expect(page.getByRole('textbox', { name: 'Time', exact: true })).toHaveValue('12:00 PM')
    await expect(page.getByRole('checkbox', { name: 'Open in editor' })).toBeChecked()
    await expect(page.getByRole('combobox', { name: 'Post type' })).toContainText('Post or thread')
    await page.getByRole('button', { name: 'Plan draft', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Write some content')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
  await page.getByRole('button', { name: `Create draft ${day}`, exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Post content' })
    .fill('A planned post from the authenticated calendar')
  await page.getByRole('checkbox', { name: 'Open in editor' }).uncheck()
  await page.getByRole('textbox', { name: 'Time', exact: true }).fill('12:07')
  await page.getByRole('button', { name: 'Plan draft', exact: true }).click()
  const card = page
    .getByTestId('calendar-planned')
    .filter({ hasText: 'A planned post from the authenticated calendar', visible: true })
  await expect(card).toBeVisible()
  let draftId = '',
    version = 0,
    calendarVersion = 0,
    plannedFor = ''
  await test.step('P33 planning persists a placement and no publication job', async () => {
    const rows = await db.query(
      'SELECT id,version,"calendarVersion","plannedFor" FROM content_draft WHERE "organizationId"=$1 AND "plainText"=$2',
      [workspace.id, 'A planned post from the authenticated calendar']
    )
    expect(rows.rows).toHaveLength(1)
    ;({ id: draftId, version, calendarVersion } = rows.rows[0])
    plannedFor = rows.rows[0].plannedFor.toISOString()
    expect(
      (await db.query('SELECT id FROM scheduled_post WHERE "contentDraftId"=$1', [draftId])).rows
    ).toHaveLength(0)
  })
  await test.step('P12 simultaneous posts from different accounts remain clickable in Week view', async () => {
    const created = await apiRequest(page, '/api/v1/content-drafts', {
      method: 'POST',
      body: {
        socialSetId: second.id,
        plainText: 'Overlapping weekly account post',
        channelConnectionIds: [workspace.channels.linkedin],
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const overlapping = created.body as { id: string; calendarVersion: number }
    const planned = await apiRequest(page, `/api/v1/content-drafts/${overlapping.id}/plan`, {
      method: 'POST',
      // 12:07 on its own Tokyo clock, the first brand's New York time: same day, same hour.
      body: {
        plannedFor: new Date(`${day}T12:07:00+09:00`).toISOString(),
        timeZone: 'Asia/Tokyo',
        baseCalendarVersion: overlapping.calendarVersion,
      },
    })
    expect(planned.status, JSON.stringify(planned.body)).toBe(200)
    await app.open(`/publish/calendar?day=${day}`)
    await chooseOption(page.getByLabel('Calendar view'), 'Week')
    await expect(page.getByLabel('week calendar', { exact: true })).toBeVisible()
    const other = page
      .getByTestId('calendar-planned')
      .filter({ hasText: 'Overlapping weekly account post', visible: true })
    await expect(card).toBeVisible()
    await expect(other).toBeVisible()
    await expect
      .poll(async () => {
        const firstBox = await card.boundingBox()
        const secondBox = await other.boundingBox()
        return (
          !!firstBox &&
          !!secondBox &&
          (firstBox.x + firstBox.width <= secondBox.x ||
            secondBox.x + secondBox.width <= firstBox.x)
        )
      })
      .toBe(true)
    for (const [target, text] of [
      [card, 'A planned post from the authenticated calendar'],
      [other, 'Overlapping weekly account post'],
    ] as const) {
      await target.click()
      await expect(page.getByRole('dialog').getByText(text, { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
    }
    const revision = planned.body as { version: number; calendarVersion: number }
    expect(
      (
        await apiRequest(
          page,
          `/api/v1/content-drafts/${overlapping.id}?version=${revision.version}&calendarVersion=${revision.calendarVersion}`,
          { method: 'DELETE' }
        )
      ).status
    ).toBe(200)
    await chooseOption(page.getByLabel('Calendar view'), 'Month')
    await app.reload()
  })
  await test.step('P16 P17 P18 filters density week start and unavailable-tag recovery retain accounts', async () => {
    await page.getByText('Filters', { exact: true }).click()
    await page.getByRole('checkbox', { name: 'Published', exact: true }).check()
    await expect(card).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear filters' }).click()
    await page.getByText('Filters', { exact: true }).click()
    await expect(card).toBeVisible()
    await page.getByText('Display', { exact: true }).click()
    await chooseOption(page.getByRole('combobox', { name: 'Card density' }), 'Compact')
    await chooseOption(page.getByRole('combobox', { name: 'Week starts' }), 'Sunday')
    await page.getByText('Display', { exact: true }).click()
    await app.reload()
    await expect(
      page.getByTestId('calendar-planned').filter({ visible: true }).first()
    ).toBeVisible()
  })
  await test.step('P17 unavailable tag options have a retry separate from a valid empty filter', async () => {
    await page.route('**/api/v1/social-sets/*/tags', (route) =>
      route.fulfill({ status: 503, json: { message: 'Temporary tag outage' } })
    )
    await app.reload()
    await page.getByText('Filters', { exact: true }).click()
    await expect(page.getByText('Tags are unavailable', { exact: false })).toBeVisible()
    await page.unroute('**/api/v1/social-sets/*/tags')
    await page.getByRole('button', { name: 'Retry tags', exact: true }).click()
    await expect(page.getByText('Tags are unavailable', { exact: false })).toHaveCount(0)
    await page.getByText('Filters', { exact: true }).click()
  })
  await test.step('P34 browser drag swap and Undo persist both placements', async () => {
    // A neighbouring day in the same calendar week, so both cards stay in view:
    // the day after would land in the next month when the post is on a
    // month's last Saturday.
    const saturday =
      new Date(plannedFor).toLocaleDateString('en-US', {
        weekday: 'short',
        timeZone: 'America/New_York',
      }) === 'Sat'
    const targetTime = new Date(
      Date.parse(plannedFor) + (saturday ? -1 : 1) * 86400000
    ).toISOString()
    const other = await apiRequest(page, '/api/v1/calendar/mutations', {
      method: 'POST',
      body: {
        key: randomUUID(),
        action: 'move',
        items: [
          {
            draftId: sourceId,
            version: 1,
            calendarVersion: 1,
            at: targetTime,
            timeZone: 'America/New_York',
          },
        ],
      },
    })
    expect(other.status, JSON.stringify(other.body)).toBe(200)
    await app.reload()
    const target = page
      .getByTestId('calendar-planned')
      .filter({ hasText: 'Picker source draft', visible: true })
    const swapResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/calendar/mutations') && response.request().method() === 'POST'
    )
    await card.dragTo(target)
    expect((await swapResponse).status()).toBe(200)
    await expect
      .poll(
        async () =>
          (
            (await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).body as {
              plannedFor: string
            }
          ).plannedFor
      )
      .toBe(targetTime)
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click()
    await expect
      .poll(
        async () =>
          (
            (await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).body as {
              plannedFor: string
            }
          ).plannedFor
      )
      .toBe(plannedFor)
    const clean = (await apiRequest(page, `/api/v1/content-drafts/${draftId}`)).body as {
      calendarVersion: number
    }
    calendarVersion = clean.calendarVersion
    await app.reload()
    await expect(card).toBeVisible()
  })
  await test.step('P22 P23 a card reads on its brand clock and names the zone, stored UTC unchanged', async () => {
    await expect(card).toContainText(/12:07\sPM\sE[SD]T/)
    expect(
      (
        await db.query('SELECT "plannedFor" FROM content_draft WHERE id=$1', [draftId])
      ).rows[0].plannedFor.toISOString()
    ).toBe(plannedFor)
  })
  await test.step('date notes persist on their day, and are never posts', async () => {
    await page.getByRole('button', { name: `Add note ${day}`, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Add note', exact: true })).toBeDisabled()
    await dialog.getByLabel('Title').fill('   ')
    await expect(dialog.getByRole('button', { name: 'Add note', exact: true })).toBeDisabled()
    await dialog.getByLabel('Title').fill('Launch review')
    await dialog.getByRole('radio', { name: 'purple' }).click()
    await dialog.getByRole('button', { name: 'Add note', exact: true }).click()
    const note = page
      .locator(`[data-calendar-date="${day}"]`)
      .getByRole('button', { name: 'Note: Launch review', exact: true })
    await expect(note).toBeVisible()
    expect(
      (await db.query('SELECT color FROM calendar_note WHERE "organizationId"=$1', [workspace.id]))
        .rows
    ).toEqual([{ color: 'purple' }])

    await app.reload()
    await note.click()
    await page.getByRole('dialog').getByLabel('Title').fill('Launch moved')
    await page.getByRole('button', { name: 'Save note', exact: true }).click()
    const edited = page
      .locator(`[data-calendar-date="${day}"]`)
      .getByRole('button', { name: 'Note: Launch moved', exact: true })
    await expect(edited).toBeVisible()
    await edited.click()
    await page.getByRole('button', { name: 'Delete note', exact: true }).click()
    await expect(edited).toHaveCount(0)
  })
  await test.step('P34 P36 a move has a durable inverse and stale replay cannot overwrite it', async () => {
    const target = new Date(Date.parse(plannedFor) + 86400000).toISOString()
    const body = {
      key: randomUUID(),
      action: 'move',
      items: [{ draftId, version, calendarVersion, at: target, timeZone: 'America/New_York' }],
    }
    const moved = await apiRequest(page, '/api/v1/calendar/mutations', { method: 'POST', body })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(
      (await apiRequest(page, '/api/v1/calendar/mutations', { method: 'POST', body })).body
    ).toEqual(moved.body)
    expect(
      (
        await apiRequest(page, '/api/v1/calendar/mutations', {
          method: 'POST',
          body: { ...body, key: randomUUID() },
        })
      ).status
    ).toBe(409)
    const undo = (moved.body as { undo: unknown[] }).undo
    expect(
      (
        await apiRequest(page, '/api/v1/calendar/mutations', {
          method: 'POST',
          body: { key: randomUUID(), action: 'move', items: undo },
        })
      ).status
    ).toBe(200)
    await app.reload()
    await expect(card).toBeVisible()
  })
  await test.step('P35 detail preserves provider context and schedules the planned content through its review', async () => {
    await card.click()
    await expect(
      page.getByRole('dialog').getByText(/Planned for .*12:07\sPM\sE[SD]T/)
    ).toBeVisible()
    // Plan never commits a schedule itself: it opens the draft's own review at that time.
    await page.getByRole('button', { name: 'Review and schedule…', exact: true }).click()
    await page.waitForURL(new RegExp(`/publish/${draftId}\\?.*panel=schedule`))
    const review = page.getByTestId('schedule-dialog')
    await expect(review.getByTestId('schedule-summary')).toContainText('America/New_York')
    await expect(review.getByTestId('destinations')).toBeVisible()
    await review.getByRole('checkbox', { name: 'Open a new draft after scheduling' }).uncheck()
    await review.getByRole('button', { name: /^Confirm schedule/ }).click()
    await expect(review).toHaveCount(0)
    const scheduled = await db.query(
      `SELECT status::text, "scheduleTimeZone" FROM scheduled_post WHERE "contentDraftId"=$1`,
      [draftId]
    )
    expect(scheduled.rows.length).toBeGreaterThan(0)
    expect(scheduled.rows.every((r) => r.status === 'SCHEDULED')).toBe(true)
    await app.open(`/publish/calendar?day=${day}`)
    await expect(
      page.getByTestId('calendar-post').filter({ hasText: 'A planned post', visible: true })
    ).toBeVisible()
  })
  await test.step('P33 unscheduling retains a planned position and cancels its durable job', async () => {
    await page
      .getByTestId('calendar-post')
      .filter({ hasText: 'A planned post', visible: true })
      .click()
    await page.getByRole('button', { name: 'Unschedule', exact: true }).click()
    await expect(card).toBeVisible()
    const rows = (
      await db.query('SELECT status::text FROM scheduled_post WHERE "contentDraftId"=$1', [draftId])
    ).rows
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true)
  })
  await test.step('P27 published reuse keeps history and a lost response cannot duplicate the new draft', async () => {
    const source = (await apiRequest(page, `/api/v1/content-drafts/${sourceId}`)).body as {
      version: number
      calendarVersion: number
    }
    const scheduled = await apiRequest(page, `/api/v1/content-drafts/${sourceId}/schedule`, {
      method: 'POST',
      body: {
        version: source.version,
        baseCalendarVersion: source.calendarVersion,
        channelConnectionIds: [workspace.channels.x],
        scheduledFor: new Date(Date.now() + 86400000).toISOString(),
        timeZone: 'America/New_York',
      },
    })
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201)
    // Explicit provider-result fixture; no live external publication is claimed.
    await db.query(
      `UPDATE scheduled_post SET status='PUBLISHED', "remotePostId"='history-fixture' WHERE "contentDraftId"=$1`,
      [sourceId]
    )
    await app.reload()
    await page.getByRole('button', { name: `Create draft ${day}`, exact: true }).click()
    await page.getByRole('button', { name: 'Choose existing content' }).click()
    await page.getByRole('button', { name: 'Published', exact: true }).click()
    await page.getByLabel('Search existing content').fill('Picker source')
    await page.getByRole('button', { name: /Picker source draft/ }).click()
    await page.getByRole('checkbox', { name: 'Open in editor' }).uncheck()
    let firstResponse = true
    const path = '**/api/v1/content-drafts/*/duplicate?*'
    await page.route(path, async (route) => {
      const response = await route.fetch()
      if (firstResponse) {
        firstResponse = false
        await route.abort('failed')
      } else await route.fulfill({ response })
    })
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible()
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.unroute(path)
    expect(
      (await db.query('SELECT id FROM content_draft WHERE "sourceDraftId"=$1', [sourceId])).rows
    ).toHaveLength(1)
    expect(
      (
        await db.query(
          'SELECT status,"remotePostId" FROM scheduled_post WHERE "contentDraftId"=$1',
          [sourceId]
        )
      ).rows
    ).toEqual([{ status: 'PUBLISHED', remotePostId: 'history-fixture' }])
  })
  await test.step('P40 mobile queue and keyboard controls are usable', async () => {
    // Typing in a search field is text, not a calendar shortcut.
    await page.getByRole('button', { name: 'Drafts', exact: true }).first().click()
    const search = page.getByLabel('Search sidebar drafts')
    await search.click()
    await page.keyboard.press('w')
    await expect(search).toHaveValue('w')
    await expect(page.getByLabel('Calendar view')).toContainText('Month')
    await page.getByRole('button', { name: 'Back to profiles' }).click()
    await page.locator('body').click({ position: { x: 1270, y: 10 } })
    await page.keyboard.press('v')
    await expect(page.getByLabel('Calendar view')).toContainText('Week')
    await page.keyboard.press('m')
    await page.screenshot({ path: '.local/plan-analyze/plan-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByLabel('Mobile queue')).toBeVisible()
    await expect(card).toBeVisible()
    await page.screenshot({ path: '.local/plan-analyze/plan-mobile.png', fullPage: true })
    expect(runtimeErrors).toEqual([])
  })
})

test('Analyze acceptance: scoped reports, chart and post exports, goals, and public revoke', async ({
  app,
  browser,
  page,
  startWorkspace,
}) => {
  test.setTimeout(360_000)
  const runtimeErrors: string[] = []
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  const workspace = await startWorkspace({ channels: ['x', 'linkedin'] })
  const observed = new Date(Date.now() - 60000),
    published = new Date(Date.now() - 86400000)
  await db.query(
    'INSERT INTO analytics_account (id,"organizationId",availability,"checkedAt") VALUES ($1,$2,\'available\',now())',
    [workspace.channels.x, workspace.id]
  )
  for (let i = 0; i < 2; i++) {
    const id = randomUUID(),
      remote = `fixture-${i}`
    await db.query(
      'INSERT INTO analytics_post (id,"organizationId","connectionId","remoteId",excerpt,url,"publishedAt",availability,"isReply","threadRootId","threadPosition") VALUES ($1,$2,$3,$4,$5,$6,$7,\'available\',$8,\'fixture-0\',$9)',
      [
        id,
        workspace.id,
        workspace.channels.x,
        remote,
        i ? 'A thread continuation' : '=A formula-safe fixture, "quoted"',
        `https://x.com/i/status/${remote}`,
        new Date(published.getTime() + i * 3600000),
        i === 1,
        i,
      ]
    )
    await db.query(
      'INSERT INTO analytics_snapshot (id,"organizationId","connectionId","subjectId",kind,"observedAt",counters,"payloadHash") VALUES ($1,$2,$3,$4,\'post\',$5,$6,$7)',
      [
        randomUUID(),
        workspace.id,
        workspace.channels.x,
        remote,
        observed,
        JSON.stringify({
          impressions: i ? 100 : 0,
          likes: i ? 5 : 0,
          replies: 0,
          reposts: 0,
          bookmarks: 0,
        }),
        randomUUID(),
      ]
    )
  }
  await db.query(
    'INSERT INTO analytics_snapshot (id,"organizationId","connectionId","subjectId",kind,"observedAt",counters,"payloadHash") VALUES ($1,$2,$3,$3,\'account\',$4,\'{"followers":1200000}\',$5)',
    [randomUUID(), workspace.id, workspace.channels.x, observed, randomUUID()]
  )
  // Refresh asks the provider first; these steps are about re-reading the stored report.
  await page.route('**/api/v1/analytics/*/refresh', (route) =>
    route.fulfill({ json: { refreshed: true } })
  )
  await test.step('A00 Analyze opens on the whole brand, broken down per account', async () => {
    await app.open('/publish/analyze')
    await expect(page.getByLabel('Analytics account')).toContainText('All accounts')
    await expect(page.getByRole('row', { name: /^All accounts/ })).toContainText('2')
    await expect(page.getByRole('row', { name: /^X · / })).toContainText('1.2M')
    await expect(page.getByRole('row', { name: /^LinkedIn · / })).toContainText(
      'Not available on this network'
    )
    await page.getByRole('button', { name: /^X · / }).click()
    await expect(page.getByLabel('Analytics account')).toContainText(' · X · ')
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
  })
  await app.open(`/publish/analyze?account=${workspace.channels.x}&limit=1`)
  await test.step('A01 A06 A07 all seven areas show account scope and exact accessible totals', async () => {
    await expect(page.getByLabel('Analytics account')).toContainText(' · X · ')
    for (const title of [
      'Followers',
      'Impressions',
      'Published Posts',
      'Profile Clicks',
      'Engagements',
      'Hourly Engagement',
      'Posting Streak',
    ])
      await expect(page.getByRole('heading', { name: title, exact: true }).first()).toBeVisible()
    await expect(page.getByLabel('Followers: 1,200,000')).toHaveText('1.2M')
  })
  await test.step('A02 A03 A04 account changes clear old values and show capability-based availability', async () => {
    await chooseOption(page.getByLabel('Analytics account'), / · LinkedIn · /)
    await expect(page.getByLabel('Followers: 1,200,000')).toHaveCount(0)
    // No cards of dashes, no grid of empty hours, no goal: one notice and the real post count.
    await expect(
      page.getByRole('heading', { name: 'Stats aren’t available for this account' })
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Published Posts', exact: true })).toBeVisible()
    for (const title of ['Followers', 'Hourly Engagement', 'Posting Streak'])
      await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0)
    await chooseOption(page.getByLabel('Analytics account'), / · X · /)
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
  })
  await test.step('A05 decorative loading is inaccessible and A02 aborted responses cannot cross accounts', async () => {
    const path = `**/api/v1/analytics/${workspace.channels.x}?*`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await chooseOption(page.getByLabel('Analytics account'), / · LinkedIn · /)
    await expect(
      page.getByText('No confirmed posts in this scope.', { exact: false })
    ).toBeVisible()
    await page.route(path, async (route) => {
      const response = await route.fetch()
      await gate
      await route.fulfill({ response }).catch(() => {})
    })
    await chooseOption(page.getByLabel('Analytics account'), / · X · /)
    await expect(page.getByRole('status').filter({ hasText: 'Loading analytics' })).toBeVisible()
    await expect(page.locator('[aria-hidden="true"] .animate-pulse')).toHaveCount(6)
    await expect(page.getByLabel('Followers: 1,200,000')).toHaveCount(0)
    await chooseOption(page.getByLabel('Analytics account'), / · LinkedIn · /)
    release()
    await expect(
      page.getByText('No confirmed posts in this scope.', { exact: false })
    ).toBeVisible()
    await expect(page.getByLabel('Followers: 1,200,000')).toHaveCount(0)
    await page.unroute(path)
    await chooseOption(page.getByLabel('Analytics account'), / · X · /)
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
  })
  await test.step('A04 A17 one malformed metric preserves neighboring cards and recovers independently', async () => {
    const path = `**/api/v1/analytics/${workspace.channels.x}?*`
    await page.route(path, async (route) => {
      const response = await route.fetch()
      const data = await response.json()
      data.metrics.impressions = { ...data.metrics.impressions, points: null }
      await route.fulfill({ response, json: data })
    })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry metric', exact: true })).toBeVisible()
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
    await page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: 'Impressions', exact: true }) })
      .click()
    await expect(page.getByText('No observations for this series.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Overview' }).click()
    await page.unroute(path)
    await page.getByRole('button', { name: 'Retry metric', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry metric', exact: true })).toHaveCount(0)
  })
  await test.step('A16 A28 A35 legitimate zero chart exports independently from an empty post list', async () => {
    await chooseOption(page.getByLabel('Analytics account'), / · LinkedIn · /)
    await expect(
      page.getByText('No confirmed posts in this scope.', { exact: false })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Export posts CSV' })).toBeDisabled()
    await page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: 'Published Posts', exact: true }) })
      .click()
    await expect(page.getByRole('button', { name: 'Export chart CSV' })).toBeEnabled()
    await expect(page.getByRole('img', { name: /Observed values/ })).toBeVisible()
    await page.getByRole('button', { name: 'Overview' }).click()
    await chooseOption(page.getByLabel('Analytics account'), / · X · /)
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
  })
  await test.step('A18 metric help opens its actual definition', async () => {
    await page.getByRole('button', { name: 'About Followers', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Last observed follower count')
    await page.keyboard.press('Escape')
  })
  await test.step('A40 transient report failure retries without logging out or changing scope', async () => {
    const account = (await page.getByLabel('Analytics account').textContent()) ?? ''
    const path = `**/api/v1/analytics/${workspace.channels.x}?*`
    await page.route(path, (route) =>
      route.fulfill({ status: 503, json: { message: 'Fixture analytics outage' } })
    )
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Fixture analytics outage' })
    ).toBeVisible()
    await page.unroute(path)
    await page.getByRole('button', { name: 'Retry analytics', exact: true }).click()
    await expect(page.getByLabel('Followers: 1,200,000')).toBeVisible()
    await expect(page.getByLabel('Analytics account')).toHaveText(account)
  })
  await test.step('A09 A10 A11 A12 dates grouping and explicit scope stay synchronized', async () => {
    const range = page.getByRole('button', { name: 'Date range', exact: true })
    const preset = async (name: string) => {
      await range.click()
      await page
        .getByRole('group', { name: 'Presets' })
        .getByRole('button', { name, exact: true })
        .click()
    }
    await range.click()
    await expect(page.getByRole('group', { name: 'Presets' }).getByRole('button')).toHaveCount(10)
    await page.keyboard.press('Escape')
    await preset('1 year')
    await expect(page.getByLabel('Grouping')).toContainText('Monthly')
    await preset('1 month')
    await expect(page.getByLabel('Grouping')).toContainText('Daily')
    // Picking the later day first still gives a valid range, applied with no Apply button.
    const today = new Date()
    const earlier = new Date(Date.now() - 3 * 86_400_000)
    await range.click()
    await page
      .getByRole('button', { name: format(today, 'PPPP') })
      .first()
      .click()
    await page
      .getByRole('button', { name: format(earlier, 'PPPP') })
      .first()
      .click()
    await expect(page).toHaveURL(new RegExp(`from=${format(earlier, 'yyyy-MM-dd')}`))
    await expect(page).toHaveURL(new RegExp(`to=${format(today, 'yyyy-MM-dd')}`))
    await expect(range).toContainText(format(today, 'MMM d, yyyy'))
    await preset('7 days')
    await expect(range).toContainText('7 days')
  })
  await test.step('A13 A14 A15 A16 A17 A18 A34 A35 expanded chart works independently of post data', async () => {
    await page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: 'Followers', exact: true }) })
      .click()
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible()
    await page.getByLabel('Interval growth').check()
    await expect(page.getByText('No observations for this series.', { exact: false })).toBeVisible()
    await page.getByLabel('Interval growth').uncheck()
    await chooseOption(page.getByLabel('Grouping'), 'Weekly')
    await expect(page.getByRole('img', { name: /Observed values/ })).toBeVisible()
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export chart CSV' }).click()
    const file = await download
    const content = await readFile((await file.path())!, 'utf8')
    expect(content).toContain('"1200000"')
    expect(content).toContain('"weekly"')
    await page.getByRole('button', { name: 'Overview' }).click()
  })
  await test.step('A21 A22 A23 A24 A25 hourly modes and exact cell drilldown show sample evidence', async () => {
    await chooseOption(page.getByLabel('Hourly mode'), 'Days')
    await page.getByLabel('Weekday').click()
    await expect(page.getByRole('option')).toHaveCount(7)
    await page.keyboard.press('Escape')
    await chooseOption(page.getByLabel('Hourly mode'), 'Heatmap')
    await expect(
      page
        .getByRole('table')
        .filter({ has: page.getByText('Seven weekdays by 24 hours', { exact: false }) })
        .locator('tbody td')
    ).toHaveCount(168)
    await page
      .getByRole('button', { name: /average, 1 posts/ })
      .first()
      .click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
  })
  await test.step('A26 A27 goal cancel does not persist and explicit save does', async () => {
    await page.getByRole('button', { name: 'Set posting goal' }).click()
    await chooseOption(page.getByLabel('Goal cadence'), 'Weekly')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Set posting goal' }).click()
    await expect(page.getByLabel('Goal cadence')).toContainText('Daily')
    await chooseOption(page.getByLabel('Goal cadence'), 'Weekly')
    await page.getByRole('button', { name: 'Save goal' }).click()
    await expect(page.getByRole('button', { name: 'Edit goal' })).toBeVisible()
  })
  await test.step('A29 A30 A31 A32 A33 A34 exact post rows sort and export safe full-precision CSV', async () => {
    await chooseOption(page.getByLabel('Sort posts'), 'Likes')
    await chooseOption(page.getByLabel('Post scope'), 'Replies')
    await expect(page.getByRole('row').filter({ hasText: 'A thread continuation' })).toHaveCount(1)
    await page.getByRole('button', { name: 'Statistics', exact: true }).click()
    await expect(page.getByRole('link', { name: 'View this post' })).toHaveAttribute(
      'href',
      'https://x.com/i/status/fixture-1'
    )
    await page.keyboard.press('Escape')
    await chooseOption(page.getByLabel('Post scope'), 'All')
    await page.getByRole('columnheader').getByRole('button', { name: 'Likes', exact: true }).click()
    await expect(page.getByLabel('Sort posts')).toContainText('Likes')
    const firstPost = await page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Statistics', exact: true }) })
      .innerText()
    await page.getByRole('button', { name: 'Next page', exact: true }).click()
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: 'Statistics', exact: true }) })
    ).not.toHaveText(firstPost, { useInnerText: true })
    await expect(page.getByLabel('Sort posts')).toContainText('Likes')
    await page.getByRole('button', { name: 'Previous page', exact: true }).click()
    await expect(
      page
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: 'Statistics', exact: true }) })
    ).toHaveText(firstPost, { useInnerText: true })
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export posts CSV' }).click()
    const content = await readFile((await (await download).path())!, 'utf8')
    expect(content).toContain('"\'=A formula-safe fixture, ""quoted"""')
    expect(content).toContain('"0.05"')
  })
  await test.step('A36 A37 public opt-in excludes private controls and revocation blocks subsequent reads', async () => {
    await page.getByRole('button', { name: 'Public sharing' }).click()
    await expect(page.getByRole('button', { name: 'Enable public analytics' })).toBeVisible()
    await page.getByRole('button', { name: 'Enable public analytics' }).click()
    const link = page.getByRole('link', { name: 'Open public page' })
    await expect(link).toBeVisible()
    const href = (await link.getAttribute('href'))!
    const anonymous = await browser.newContext()
    const publicPage = await anonymous.newPage()
    await publicPage.goto(new URL(href, page.url()).href)
    await expect(publicPage.getByRole('heading', { name: 'Analyze', exact: true })).toBeVisible()
    await expect(publicPage.getByLabel('Analytics account')).toHaveCount(0)
    await expect(publicPage.getByRole('button', { name: 'Public sharing' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Revoke public access' }).click()
    await expect(page.getByRole('button', { name: 'Enable public analytics' })).toBeVisible()
    await publicPage.reload()
    await expect(
      publicPage.getByRole('alert').filter({ hasText: /unavailable|no longer shared|revoked/ })
    ).toContainText(/unavailable|no longer shared|revoked/)
    await anonymous.close()
    await page.keyboard.press('Escape')
  })
  await test.step('A38 A39 chart sharing uses the design renderer without enabling public sharing', async () => {
    await page
      .getByRole('button')
      .filter({ has: page.getByRole('heading', { name: 'Followers', exact: true }) })
      .click()
    await page.getByRole('button', { name: 'Share chart image' }).click()
    await expect(page.getByRole('dialog')).toContainText('Create chart image')
    for (const label of [
      'Image crop',
      'Image color',
      'Image frame',
      'Image gradient',
      'Inset',
      'Corner radius',
      'Rotation',
      'Crop zoom',
      'Image shadow',
    ])
      await expect(page.getByLabel(label, { exact: true })).toBeVisible()
    await chooseOption(page.getByLabel('Image crop'), 'Square')
    await page.getByLabel('Image color').click()
    await page.getByLabel('Hex color').fill('#2a4860')
    await page.getByLabel('Hex color').press('Enter')
    await page.keyboard.press('Escape')
    await page.getByLabel('Image frame').click()
    await page.getByRole('option').nth(1).click()
    await page.getByLabel('Image gradient').click()
    await page.getByRole('option').nth(1).click()
    await chooseOption(page.getByLabel('Image shadow'), 'strong')
    for (const label of ['Inset', 'Corner radius', 'Rotation', 'Crop zoom']) {
      const control = page.getByRole('slider', { name: label, exact: true })
      const before = Number(await control.getAttribute('aria-valuenow'))
      await control.focus()
      await page.keyboard.press('ArrowRight')
      await expect(control).toHaveAttribute('aria-valuenow', String(before + 1))
    }
    await expect(page.getByRole('img', { name: /image preview/ })).toBeVisible()
    const download = page.waitForEvent('download', { timeout: 90_000 })
    await page.getByRole('button', { name: 'Create image', exact: true }).click()
    const artifact = await download
    const bytes = await readFile((await artifact.path())!)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    expect(bytes.readUInt32BE(16)).toBe(1200)
    expect(bytes.readUInt32BE(20)).toBe(1200)
    await artifact.saveAs('.local/plan-analyze/chart-image.png')
    await page.keyboard.press('Escape')
    const state = await apiRequest(
      page,
      `/api/v1/analytics/${workspace.channels.x}?${new URL(page.url()).searchParams.toString()}`
    )
    expect(state.status).toBe(200)
    expect(
      (state.body as { settings: { publicToken: string | null } }).settings.publicToken
    ).toBeNull()
  })
  await page.getByRole('button', { name: '← Overview' }).click()
  await expect(page.getByRole('heading', { name: 'Followers', exact: true })).toBeVisible()
  await page.screenshot({ path: '.local/plan-analyze/analyze-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('heading', { name: 'Posting streak' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('heading', { name: 'Posting streak' })).toBeInViewport()
  await page.screenshot({ path: '.local/plan-analyze/analyze-mobile.png' })
  expect(runtimeErrors).toEqual([])
})

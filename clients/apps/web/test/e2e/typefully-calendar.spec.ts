import { format } from 'date-fns'
import { apiRequest, db, draftEditor, expect, test } from './framework'

test(
  'month moves and swaps persist, failed moves stay put, and publish now requires confirmation',
  { tag: '@journey' },
  async ({ app, page, startWorkspace }) => {
    const workspace = await startWorkspace({ channels: ['x'] })
    const anchor = new Date(Date.now() + 10 * 86_400_000)
    anchor.setUTCHours(10, 0, 0, 0)
    const secondAt = new Date(anchor.getTime() + 86_400_000)
    const create = async (title: string, at: Date) => {
      const made = await apiRequest(page, '/api/v1/content-drafts', {
        method: 'POST',
        body: { title, plainText: title, body: [{ type: 'p', children: [{ text: title }] }] },
      })
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      const draft = made.body as { id: string; version: number }
      const scheduled = await apiRequest(page, `/api/v1/content-drafts/${draft.id}/schedule`, {
        method: 'POST',
        body: {
          channelConnectionIds: [workspace.channels.x],
          version: draft.version,
          scheduledFor: at.toISOString(),
        },
      })
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(201)
      return draft.id
    }
    const one = await create('Calendar first', anchor)
    const two = await create('Calendar second', secondAt)
    const day = (at: Date) =>
      page.locator(`[data-calendar-date="${at.toISOString().slice(0, 10)}"]`)
    const card = (text: string) =>
      page.getByTestId('calendar-post').filter({ hasText: text, visible: true })
    await app.open(`/publish/calendar?view=month&week=${anchor.toISOString().slice(0, 10)}`)
    await expect(day(anchor)).toBeVisible()
    await expect(day(anchor)).toContainText('Calendar first')
    await expect(day(secondAt)).toContainText('Calendar second')
    const swapped = page.waitForResponse(
      (response) =>
        response.url().endsWith('/calendar/mutations') && response.request().method() === 'POST',
      { timeout: 20_000 }
    )
    await card('Calendar first').dragTo(card('Calendar second'))
    expect((await swapped).ok()).toBeTruthy()
    await expect(day(secondAt)).toContainText('Calendar first')
    await expect(day(anchor)).toContainText('Calendar second')

    // An uncertain/failed network response never claims an uncommitted slot.
    await page.route('**/calendar/mutations', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Move unavailable' }),
      })
    )
    const later = new Date(secondAt.getTime() + 86_400_000)
    // A scroll during the drag would move the card out from under the pointer.
    await day(later).scrollIntoViewIfNeeded()
    await card('Calendar first').dragTo(day(later))
    await expect(page.getByText('Move unavailable')).toBeVisible()
    await expect(day(secondAt)).toContainText('Calendar first')
    await page.unroute('**/calendar/mutations')

    // The same backend operation is accessible without dragging.
    await card('Calendar first').click()
    const dialog = page.getByRole('dialog')
    const [year, month, date] = later.toISOString().slice(0, 10).split('-').map(Number)
    await dialog.getByLabel('Day', { exact: true }).click()
    // react-day-picker names each day button with its full date.
    const nextMonth = page.getByRole('button', { name: 'Go to the Next Month' })
    await expect(nextMonth).toBeVisible()
    const dayButton = page.getByRole('button', {
      name: format(new Date(year, month - 1, date), 'PPPP'),
    })
    if (!(await dayButton.isVisible())) await nextMonth.click()
    await dayButton.click()
    await dialog.getByLabel('Time', { exact: true }).fill('13:15')
    await dialog.getByRole('button', { name: 'Move', exact: true }).click()
    await expect(day(later)).toContainText('Calendar first')
    await app.reload()
    await expect(day(later)).toContainText('Calendar first')
    await page.screenshot({ path: '.context/shots/typefully-month.png', fullPage: true })

    await app.open(`/publish/${one}`)
    const queued = page
      .getByTestId('draft-post')
      .filter({ has: page.getByRole('button', { name: 'Publish now', exact: true }) })
    // The page renders the trigger before React attaches its handler, so an early
    // click is dropped; the proof of a handled click is the open dialog.
    const confirm = page.getByRole('alertdialog')
    await expect(async () => {
      if (!(await confirm.isVisible())) {
        await queued.getByRole('button', { name: 'Publish now', exact: true }).click()
      }
      await expect(confirm).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    await expect(confirm).toContainText('Later draft edits are not included')
    await page.getByRole('button', { name: 'Keep scheduled' }).click()
    await queued.getByRole('button', { name: 'Publish now', exact: true }).click()
    const publishing = page.waitForResponse(
      (response) =>
        response.url().endsWith('/publish-now') && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Confirm publish now' }).click()
    const response = await publishing
    expect(response.ok(), await response.text()).toBeTruthy()
    const successor = (await response.json()) as { post: { id: string; scheduledFor: string } }
    expect(new Date(successor.post.scheduledFor).getTime()).toBeLessThanOrEqual(Date.now())
    const rows = await db.rows<{ id: string; status: string }>(
      'SELECT id,status FROM scheduled_post WHERE "contentDraftId"=$1 AND status<>\'CANCELLED\'',
      [one]
    )
    expect(rows.map((row) => row.id)).toEqual([successor.post.id])
    const other = await db.rows<{ status: string }>(
      'SELECT status FROM scheduled_post WHERE "contentDraftId"=$1 ORDER BY "createdAt" DESC LIMIT 1',
      [two]
    )
    expect(other[0].status).toBe('SCHEDULED')
    const past = new Date(Date.now() - 86_400_000)
    past.setUTCHours(15, 0, 0, 0)
    // A confirmed provider receipt is seeded; no real network is published to.
    await db.query(
      'UPDATE scheduled_post SET status=\'PUBLISHED\', "remotePostId"=\'123456789\', "scheduledFor"=$2, metrics=$3, "metricsAt"=now() WHERE "contentDraftId"=$1 AND status=\'SCHEDULED\'',
      // ISO, not a Date: node-postgres writes Dates in the host's time zone.
      [two, past.toISOString(), { likes: 12, replies: 3 }]
    )
    await app.open(`/publish/calendar?view=month&week=${anchor.toISOString().slice(0, 10)}`)
    await page
      .getByRole('button', {
        name: `Create draft ${anchor.toISOString().slice(0, 10)}`,
        exact: true,
      })
      .click()
    await page.getByRole('button', { name: 'Choose existing content' }).click()
    await page.getByRole('button', { name: 'Published', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /Calendar second/ })
      .click()
    await page.getByRole('checkbox', { name: 'Open in editor' }).check()
    await page.getByRole('button', { name: 'Plan', exact: true }).click()
    await page.waitForURL(/\/publish\/[a-z0-9]+$/)
    const copiedId = new URL(page.url()).pathname.split('/').pop()!
    expect(copiedId).not.toBe(two)
    await expect(draftEditor(page)).toContainText('Calendar second')
    const copied = await db.rows<{ count: string }>(
      'SELECT count(*)::text FROM scheduled_post WHERE "contentDraftId"=$1',
      [copiedId]
    )
    expect(copied[0].count).toBe('0')
    await app.open('/publish/analyze/posting-times')
    await expect(page.getByTestId('posting-times')).toContainText('1 measured posts')
    const weekday = past.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
    await page.getByRole('button', { name: `Add ${weekday} suggested slot` }).click()
    await expect(page.getByText(`Added ${weekday} at 15:00`, { exact: false })).toBeVisible()
    await app.reload()
    await expect(page.getByRole('button', { name: `Add ${weekday} suggested slot` })).toHaveText(
      'Added'
    )
    await page.screenshot({ path: '.context/shots/typefully-posting-times.png', fullPage: true })
  }
)

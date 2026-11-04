import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import {
  browserJson,
  browserRequest,
  db,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
} from './framework'
import { notificationPageSchema } from '../../lib/notifications/schema'

test.skip(!process.env.NOTIFICATIONS_E2E_PROVIDER_URL, 'Requires the isolated notification worker.')

function barrier() {
  let release = () => {}
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}

function projectNotifications() {
  execFileSync(
    'docker',
    [
      'exec',
      process.env.NOTIFICATIONS_E2E_TEMPORAL_CONTAINER ?? 'riga-notifications-temporal',
      'temporal',
      'workflow',
      'execute',
      '--type',
      'platform-maintenance-v1',
      '--task-queue',
      'platform-maintenance',
      '--workflow-id',
      `feed-e2e-${randomUUID()}`,
      '--input',
      '"notifications"',
    ],
    { stdio: 'pipe', timeout: 30_000 }
  )
}

test(
  'populated feeds preserve source identity and isolate delayed responses across tabs and workspaces',
  { tag: '@journey' },
  async ({ app, browser, context, identity, page }) => {
    const colleagueContext = await browser.newContext()
    const colleague = await colleagueContext.newPage()
    const sibling = await context.newPage()
    const held = barrier(),
      fetched = barrier(),
      delivered = barrier()
    const late = barrier(),
      lateFetched = barrier(),
      lateDelivered = barrier()
    try {
      await signUpViaApi(identity, page)
      const createWorkspace = async (name: string) => {
        const response = await requestJson(page, '/api/auth/organization/create', {
          name,
          slug: `feed-${randomUUID()}`,
        })
        expect(response.status).toBe(200)
        const workspace = z.object({ id: z.string() }).parse(response.body)
        await grantWorkspacePlan(workspace.id, 'business')
        return workspace.id
      }
      const alpha = await createWorkspace('Feed Alpha workspace')
      const beta = await createWorkspace('Feed Beta workspace')
      expect(
        (await requestJson(page, '/api/auth/organization/set-active', { organizationId: alpha }))
          .status
      ).toBe(200)
      const owner = z
        .object({ user: z.object({ id: z.string() }) })
        .parse(await browserJson(page, '/api/auth/get-session')).user
      const invited = await requestJson(page, '/api/auth/organization/invite-member', {
        email: `feed-${identity.email}`,
        role: 'admin',
        organizationId: alpha,
      })
      expect(invited.status).toBe(200)
      const invitation = z.object({ id: z.string() }).parse(invited.body)
      await signUpViaApi(
        { ...identity, email: `feed-${identity.email}`, name: 'Feed colleague' },
        colleague
      )
      expect(
        (
          await requestJson(colleague, '/api/auth/organization/accept-invitation', {
            invitationId: invitation.id,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await requestJson(colleague, '/api/auth/organization/set-active', {
            organizationId: alpha,
          })
        ).status
      ).toBe(200)
      const setIds: string[] = []
      const draftIds: string[] = []
      for (let index = 0; index < 2; index++) {
        const createdSet = await requestJson(page, '/api/v1/social-sets', {
          name: 'Same-name brand',
          visibility: 'WORKSPACE',
        })
        expect(createdSet.status).toBe(201)
        const set = z.object({ id: z.string() }).parse(createdSet.body)
        setIds.push(set.id)
        const createdDraft = await requestJson(page, '/api/v1/content-drafts', {
          title: `Source draft ${index}`,
          socialSetId: set.id,
        })
        expect(createdDraft.status).toBe(201)
        const draft = z.object({ id: z.string(), version: z.number() }).parse(createdDraft.body)
        draftIds.push(draft.id)
        const comment = await requestJson(
          colleague,
          `/api/v1/content-drafts/${draft.id}/comments`,
          {
            action: 'add',
            baseVersion: draft.version,
            commentId: randomUUID(),
            text: 'Please review this draft.',
            mentionUserIds: [owner.id],
          }
        )
        expect(comment.status).toBe(200)
      }
      const source = await requestJson(colleague, '/api/v1/source-apps', {
        name: 'Alpha source event',
        allowedHosts: ['https://example.test'],
        provider: 'generic',
      })
      expect(source.status).toBe(201)
      projectNotifications()
      const inboxData = notificationPageSchema.parse(
        await browserJson(page, '/api/workspace/notifications/inbox?view=inbox')
      )
      expect(inboxData.items.filter((item) => item.kind === 'comment.on_your_draft')).toHaveLength(
        2
      )
      expect(inboxData.items.filter((item) => item.kind === 'member.mentioned')).toHaveLength(2)
      expect(inboxData.items.some((item) => item.kind === 'comment.created')).toBe(false)
      expect(new Set(inboxData.items.map((item) => item.sourceSocialSet?.id))).toEqual(
        new Set(setIds)
      )
      const saved = await db.query(
        'SELECT e.notification_social_set_id FROM platform_notification_inbox i JOIN outbox_event e ON e.id=i.event_id WHERE i."organizationId"=$1 AND i."userId"=$2 AND i.kind IN ($3,$4)',
        [alpha, owner.id, 'comment.on_your_draft', 'member.mentioned']
      )
      expect(saved.rowCount).toBe(4)
      expect(
        new Set(
          saved.rows.map(
            (row) =>
              z.object({ notification_social_set_id: z.string() }).parse(row)
                .notification_social_set_id
          )
        )
      ).toEqual(new Set(setIds))

      await app.open('/settings')
      const panel = page.getByRole('dialog', { name: 'Notifications', exact: true })
      const trigger = page.getByRole('button', { name: /^Notifications/ }).first()
      const activityURL = '**/api/workspace/notifications/inbox?view=activity&*'
      await page.route(
        activityURL,
        async (route) => {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          expect(
            notificationPageSchema
              .parse(await response.json())
              .items.some((item) => item.kind === 'source_app.connected')
          ).toBe(true)
          fetched.release()
          await held.waiting
          try {
            await route.fulfill({ response })
          } finally {
            delivered.release()
          }
        },
        { times: 1 }
      )
      await trigger.click()
      await fetched.waiting
      await expect(panel.getByText('Loading notifications…', { exact: true })).toBeVisible()
      await expect(panel.getByText('No notifications', { exact: true })).toHaveCount(0)
      await panel.getByRole('tab', { name: 'Inbox', exact: true }).click()
      await expect(panel.getByText('New comment on your draft', { exact: true })).toHaveCount(2)
      await expect(panel.getByText('You were mentioned', { exact: true })).toHaveCount(2)
      for (const setId of setIds)
        await expect(panel.locator(`[data-social-set-id="${setId}"]`)).toHaveCount(2)
      held.release()
      await delivered.waiting
      await expect(panel.getByRole('tab', { name: 'Inbox', selected: true })).toBeVisible()
      await expect(panel.getByText('Source connected', { exact: true })).toHaveCount(0)
      await page.screenshot({
        path: '.context/notification-inbox-sources.png',
        animations: 'disabled',
      })

      // Fail only the browser transport after a real, authorized server read.
      let failReads = true
      await page.route(activityURL, async (route) => {
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        if (failReads)
          await route.fulfill({
            status: 503,
            contentType: 'text/html',
            body: 'Temporary gateway failure',
          })
        else await route.fulfill({ response })
      })
      await panel.getByRole('tab', { name: 'Activity', exact: true }).click()
      await expect(panel.getByRole('alert')).toContainText('The request failed. Try again.', {
        timeout: 15_000,
      })
      await expect(panel.getByText('No notifications', { exact: true })).toHaveCount(0)
      failReads = false
      await panel.getByRole('button', { name: 'Retry loading', exact: true }).click()
      await expect(panel.getByText('Source connected', { exact: true })).toBeVisible()
      await page.unroute(activityURL)

      // The denial is returned by real scope validation, never a mocked auth result.
      const archiveURL = '**/api/workspace/notifications/inbox?view=archive&*'
      let deniedRequests = 0
      await page.route(archiveURL, async (route) => {
        deniedRequests++
        const response = await route.fetch({
          headers: { ...route.request().headers(), 'x-notification-workspace': beta },
        })
        expect(response.status()).toBe(403)
        await route.fulfill({ response })
      })
      await panel.getByRole('tab', { name: 'Archive', exact: true }).click()
      await expect(panel.getByRole('alert')).toContainText('You no longer have access')
      expect(deniedRequests).toBe(1)
      await expect(panel.getByText('No notifications', { exact: true })).toHaveCount(0)
      await page.unroute(archiveURL)
      await panel.getByRole('button', { name: 'Retry loading', exact: true }).click()
      await expect(panel.getByText('No notifications', { exact: true })).toBeVisible()

      await page.route(
        activityURL,
        async (route) => {
          const response = await route.fetch()
          expect(response.status()).toBe(200)
          lateFetched.release()
          await late.waiting
          try {
            await route.fulfill({ response })
          } finally {
            lateDelivered.release()
          }
        },
        { times: 1 }
      )
      await panel.getByRole('tab', { name: 'Activity', exact: true }).click()
      await lateFetched.waiting
      await sibling.goto('/settings')
      expect(
        (await requestJson(sibling, '/api/auth/organization/set-active', { organizationId: beta }))
          .status
      ).toBe(200)
      await page.bringToFront()
      await expect(async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await expect(panel.getByText('No notifications', { exact: true })).toBeVisible({
          timeout: 1000,
        })
        await expect(panel.getByText('Source connected', { exact: true })).toHaveCount(0)
      }).toPass({ timeout: 30_000, intervals: [1000, 5000] })
      late.release()
      await lateDelivered.waiting
      await expect(panel.locator('[data-social-set-id]')).toHaveCount(0)
      await expect(panel.getByText('New comment on your draft', { exact: true })).toHaveCount(0)
      expect(
        (
          await browserRequest(page, '/api/workspace/notifications/inbox', {
            headers: { 'x-notification-workspace': alpha },
          })
        ).status
      ).toBe(403)
      await panel.getByRole('tab', { name: 'Inbox', exact: true }).click()
      await expect(panel.getByText('No notifications', { exact: true })).toBeVisible()

      // Restore the original scope and confirm data survives the race and reload.
      expect(
        (await requestJson(sibling, '/api/auth/organization/set-active', { organizationId: alpha }))
          .status
      ).toBe(200)
      await app.reload()
      await trigger.click()
      await panel.getByRole('tab', { name: 'Inbox', exact: true }).click()
      await expect(panel.getByText('New comment on your draft', { exact: true })).toHaveCount(2)
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(panel).toBeInViewport({ ratio: 0.99 })
      await page.screenshot({
        path: '.context/notification-inbox-sources-mobile.png',
        animations: 'disabled',
      })

      const staleId = inboxData.items.find(
        (item) => item.kind === 'comment.on_your_draft' && item.sourceSocialSet?.id === setIds[0]
      )?.id
      expect(staleId).toBeTruthy()
      const staleRow = panel.locator(`[data-notification-id="${staleId}"]`)
      await expect(staleRow.getByRole('button', { name: 'Open activity' })).toBeVisible()
      expect(
        (
          await browserRequest(colleague, `/api/v1/content-drafts/${draftIds[0]}`, {
            method: 'DELETE',
          })
        ).status
      ).toBe(200)
      const beforeResolve = page.url()
      await staleRow.getByRole('button', { name: 'Open activity' }).click()
      await expect(panel.getByRole('alert')).toContainText('This activity is no longer available.')
      expect(page.url()).toBe(beforeResolve)
      await page.keyboard.press('Escape')
      await app.reload()
      await page
        .getByRole('button', { name: /^Notifications/ })
        .filter({ visible: true })
        .click()
      await expect(
        panel.getByText('This activity is no longer available.', { exact: true })
      ).toHaveCount(2)
      await expect(panel.locator(`[data-social-set-id="${setIds[0]}"]`)).toHaveCount(0)
      await expect(panel.locator(`[data-social-set-id="${setIds[1]}"]`)).toHaveCount(2)
      await page.screenshot({
        path: '.context/notification-unavailable-source.png',
        animations: 'disabled',
      })
    } finally {
      held.release()
      late.release()
      await sibling.close()
      await colleagueContext.close()
    }
  }
)

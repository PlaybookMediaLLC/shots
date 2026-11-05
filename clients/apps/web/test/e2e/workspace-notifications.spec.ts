import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import {
  browserJson,
  browserRequest,
  chooseOption,
  db,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
  openDisclosureFor,
} from './framework'
import { notificationPageSchema, notificationSettingsSchema } from '../../lib/notifications/schema'

test.skip(
  !process.env.NOTIFICATIONS_E2E_PROVIDER_URL,
  'Start the isolated notification provider fixture and e2e Go binaries.'
)

test(
  'workspace activity persists read and archive state through controlled providers',
  { tag: '@journey' },
  async ({ app, browser, identity, page }) => {
    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    const provider = process.env.NOTIFICATIONS_E2E_PROVIDER_URL!
    const sink = async () =>
      z
        .object({
          slack: z.array(z.record(z.string(), z.unknown())),
          email: z.array(z.record(z.string(), z.unknown())),
          auth: z.array(z.object({ to: z.string(), text: z.string() })),
          channelPages: z.array(z.string()),
        })
        .parse(await (await fetch(`${provider}/sink`, { headers: { connection: 'close' } })).json())
    const dispatch = () =>
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
          `notification-e2e-${randomUUID()}`,
          '--input',
          '"notifications"',
        ],
        { stdio: 'pipe', timeout: 30_000 }
      )
    try {
      await signUpViaApi(identity, page)
      const workspace = z.object({ id: z.string() }).parse(
        await browserJson(page, '/api/auth/organization/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: identity.workspaceName,
            slug: `notifications-${randomUUID()}`,
          }),
        })
      )
      await grantWorkspacePlan(workspace.id, 'pro')
      const session = z
        .object({ user: z.object({ id: z.string() }) })
        .parse(await browserJson(page, '/api/auth/get-session'))
      await requestJson(page, '/api/auth/send-verification-email', {
        email: identity.email,
        callbackURL: '/settings/notifications',
      })
      await expect
        .poll(async () =>
          (await sink()).auth.some(
            (mail) => mail.to === identity.email && mail.text.includes('/verify-email')
          )
        )
        .toBe(true)
      const verification = (await sink()).auth.find(
        (mail) => mail.to === identity.email && mail.text.includes('/verify-email')
      )!
      const verificationURL = verification.text.match(
        /http:\/\/localhost:3460\/api\/auth\/verify-email\?[^\s<>]+/
      )?.[0]
      expect(verificationURL).toBeTruthy()
      await page.goto(verificationURL!)

      const colleague = {
        ...identity,
        email: `colleague-${identity.email}`,
        name: 'Activity colleague',
      }
      await signUpViaApi(colleague, otherPage)
      const otherWorkspace = z.object({ id: z.string() }).parse(
        await browserJson(otherPage, '/api/auth/organization/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Separate activity workspace',
            slug: `separate-${randomUUID()}`,
          }),
        })
      )
      await grantWorkspacePlan(otherWorkspace.id, 'pro')
      const invitation = await requestJson(page, '/api/auth/organization/invite-member', {
        email: colleague.email,
        role: 'admin',
        organizationId: workspace.id,
      })
      expect(invitation.status, JSON.stringify(invitation.body)).toBe(200)
      const invitationID = z.object({ id: z.string() }).parse(invitation.body).id
      expect(
        (
          await requestJson(otherPage, '/api/auth/organization/accept-invitation', {
            invitationId: invitationID,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await requestJson(otherPage, '/api/auth/organization/set-active', {
            organizationId: workspace.id,
          })
        ).status
      ).toBe(200)

      await app.open('/settings/notifications')
      await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
      await page.getByRole('button', { name: 'Connect Slack', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Local Slack fixture' })).toBeVisible()
      await page.getByRole('link', { name: 'Allow selected workspace' }).click()
      await expect(page.getByLabel('Slack workspace')).toBeVisible()
      await chooseOption(page.getByLabel('Slack workspace'), 'Fixture team')
      await chooseOption(page.getByLabel('Slack channel'), '#workspace-activity')
      expect((await sink()).channelPages).toContain('page-two')
      await page.getByRole('button', { name: /^Workspace rules/ }).click()
      const workspaceEmail = page.getByLabel('Repository connected: workspace email', {
        exact: true,
      })
      await openDisclosureFor(workspaceEmail)
      await workspaceEmail.check()
      await page.getByLabel('Repository connected: workspace slack', { exact: true }).check()
      await page.getByRole('button', { name: 'Save workspace policy' }).click()
      await expect(page.getByText('Workspace policy saved.')).toBeVisible()
      await page.getByRole('button', { name: 'My notifications', exact: true }).click()
      await page.getByRole('button', { name: 'Send test to my email' }).click()
      await expect(page.getByText('Test queued. Its status appears below.')).toBeVisible()
      dispatch()
      await expect(page.getByText('Test delivered.', { exact: false })).toBeVisible()
      await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
      await page.getByRole('button', { name: 'Send test to selected channel' }).click()
      await expect(page.getByText('Test queued. Its status appears below.')).toBeVisible()
      dispatch()
      await expect.poll(async () => (await sink()).slack.length).toBeGreaterThan(0)

      const createSource = async (name: string) => {
        const response = await requestJson(otherPage, '/api/v1/source-apps', {
          name,
          allowedHosts: ['https://example.test'],
          provider: 'generic',
        })
        expect(response.status, JSON.stringify(response.body)).toBe(201)
      }
      for (let index = 0; index < 12; index++) await createSource(`Activity source ${index}`)
      await expect
        .poll(
          async () => {
            dispatch()
            return (await sink()).slack.filter(
              (message) =>
                String(message.text).includes(identity.workspaceName) &&
                String(message.text).includes('Repository connected')
            ).length
          },
          { timeout: 60_000, intervals: [1200] }
        )
        .toBe(12)
      const inboxCount = async () =>
        Number(
          (
            await db.query(
              'SELECT count(*) AS n FROM platform_notification_inbox WHERE "organizationId"=$1 AND "userId"=$2 AND kind=$3',
              [workspace.id, session.user.id, 'source_app.connected']
            )
          ).rows[0].n
        )
      const unreadCount = async () =>
        Number(
          (
            await db.query(
              'SELECT count(*) AS n FROM platform_notification_inbox WHERE "organizationId"=$1 AND "userId"=$2 AND kind=$3 AND read_at IS NULL AND archived_at IS NULL',
              [workspace.id, session.user.id, 'source_app.connected']
            )
          ).rows[0].n
        )
      expect(await inboxCount()).toBe(12)
      for (const path of ['/count', '/inbox', '/count'])
        await browserJson(page, `/api/workspace/notifications${path}`)
      expect(await inboxCount()).toBe(12)
      const colleagueInbox = notificationPageSchema.parse(
        await browserJson(otherPage, '/api/workspace/notifications/inbox')
      )
      expect(
        colleagueInbox.items.filter((item) => item.kind === 'source_app.connected')
      ).toHaveLength(0)
      const delivered = await sink()
      expect(
        delivered.email.filter(
          (mail) =>
            mail.subject === 'Repository connected' &&
            JSON.stringify(mail.to).includes(identity.email)
        )
      ).toHaveLength(12)
      expect(
        delivered.slack.filter(
          (message) =>
            String(message.text).includes(identity.workspaceName) &&
            String(message.text).includes('Repository connected')
        )
      ).toHaveLength(12)
      expect(JSON.stringify(delivered.slack)).not.toContain('Activity source')

      const peer = await page.context().newPage()
      await peer.goto('/settings/notifications')
      await expect(
        peer.getByRole('button', { name: /^Notifications, \d+ unread$/ }).first()
      ).toBeVisible()
      await page.bringToFront()
      let failedAck = false
      await page.route('**/api/workspace/notifications/state', async (route) => {
        if (!failedAck) {
          failedAck = true
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"error":"Fixture interruption"}',
          })
        } else await route.continue()
      })
      await page
        .getByRole('button', { name: /^Notifications/ })
        .first()
        .click()
      const inbox = page.getByRole('dialog', { name: 'Notifications', exact: true })
      await expect(inbox.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(inbox.getByRole('tab', { selected: true })).toHaveCount(1)
      const first = inbox.locator('[data-notification-id]').first()
      await expect(first).toBeVisible()
      expect(await unreadCount()).toBe(12)
      const firstID = await first.getAttribute('data-notification-id')
      await first.getByRole('button', { name: 'Mark read', exact: true }).click()
      await expect(inbox.getByRole('alert')).toContainText('Fixture interruption')
      expect(await unreadCount()).toBe(12)
      await inbox.getByRole('button', { name: 'Retry change' }).click()
      await expect.poll(unreadCount).toBe(11)
      expect(await inboxCount()).toBe(12)
      const row = inbox.locator(`[data-notification-id="${firstID}"]`)
      await expect(row.getByRole('button', { name: 'Mark unread' })).toBeVisible()
      await page.keyboard.press('Escape')
      await page
        .getByRole('button', { name: /^Notifications/ })
        .first()
        .click()
      await expect(row.getByRole('button', { name: 'Mark unread' })).toBeVisible()
      await row.getByRole('button', { name: 'Mark unread' }).click()
      await expect.poll(unreadCount).toBe(12)
      await row.getByRole('button', { name: 'Archive notification' }).click()
      await expect(row).toHaveCount(0)
      await expect.poll(unreadCount).toBe(11)
      await inbox.getByRole('tab', { name: 'Archive', exact: true }).click()
      await expect(inbox.getByRole('tab', { name: 'Archive', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(inbox.getByRole('tab', { selected: true })).toHaveCount(1)
      await expect(row.getByRole('button', { name: 'Restore notification' })).toBeVisible()
      await page.screenshot({ path: '.context/notification-archive.png', animations: 'disabled' })
      await page.keyboard.press('Escape')
      await page
        .getByRole('button', { name: /^Notifications/ })
        .first()
        .click()
      await expect(inbox.getByRole('tab', { name: 'Archive', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await row.getByRole('button', { name: 'Restore notification' }).click()
      await expect(inbox.getByText('No notifications', { exact: true })).toBeVisible()
      await inbox.getByRole('tab', { name: 'Activity', exact: true }).click()
      await expect(row).toBeVisible()
      await inbox.getByRole('button', { name: 'Read all', exact: true }).click()
      await expect.poll(unreadCount).toBe(0)
      expect(await inboxCount()).toBe(12)
      await expect(
        peer.getByRole('button', { name: 'Notifications', exact: true }).first()
      ).toBeVisible()
      await page.screenshot({
        path: '.context/workspace-notifications.png',
        animations: 'disabled',
      })
      await inbox.getByRole('tab', { name: 'Inbox', exact: true }).click()
      await expect(inbox.getByRole('tab', { name: 'Inbox', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(inbox.getByRole('tab', { selected: true })).toHaveCount(1)
      await expect(inbox.getByText('No notifications', { exact: true })).toBeVisible()
      await page.keyboard.press('ArrowRight')
      await expect(inbox.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      const beforeSettings = page.url()
      await inbox.getByRole('button', { name: 'Notification settings' }).click()
      await expect(page.getByRole('dialog', { name: 'Notification settings' })).toBeVisible()
      expect(page.url()).toBe(beforeSettings)
      await expect
        .poll(() =>
          page
            .getByRole('dialog', { name: 'Notification settings' })
            .evaluate((element) => element.contains(document.activeElement))
        )
        .toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('button', { name: /^Notifications/ }).first()).toBeFocused()
      await page
        .getByRole('button', { name: /^Notifications/ })
        .first()
        .click()
      await row.getByRole('button', { name: 'Open activity' }).click()
      await expect(page).toHaveURL(/\/settings\/integrations$/)
      await app.open('/settings/notifications')
      await peer.close()

      await page.getByRole('button', { name: 'My notifications', exact: true }).click()
      const personalEmail = page.getByLabel('Repository connected: your email preference', {
        exact: true,
      })
      await openDisclosureFor(personalEmail)
      await personalEmail.uncheck()
      await page.getByRole('button', { name: 'Save my preferences' }).click()
      await expect(page.getByText('Your preferences are saved.')).toBeVisible()
      await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
      await expect(page.getByText('No Slack workspace is connected.')).toBeVisible()
      const before = await sink()
      await createSource('After opt-out and disconnect')
      dispatch()
      expect(await inboxCount()).toBe(13)
      expect(await unreadCount()).toBe(1)
      const after = await sink()
      expect(after.email.length).toBe(before.email.length)
      expect(after.slack.length).toBe(before.slack.length)
      expect(
        notificationSettingsSchema.parse(await browserJson(page, '/api/workspace/notifications'))
          .connections
      ).toHaveLength(0)

      expect(
        (
          await requestJson(otherPage, '/api/auth/organization/set-active', {
            organizationId: otherWorkspace.id,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await browserRequest(otherPage, '/api/workspace/notifications/inbox', {
            headers: { 'x-notification-workspace': workspace.id },
          })
        ).status
      ).toBe(403)
      expect(
        notificationPageSchema.parse(
          await browserJson(otherPage, '/api/workspace/notifications/inbox')
        ).items
      ).toHaveLength(0)

      await page.setViewportSize({ width: 390, height: 844 })
      await page
        .getByRole('button', { name: /^Notifications/ })
        .filter({ visible: true })
        .click()
      await expect(inbox).toBeVisible()
      expect(await unreadCount()).toBe(1)
      await expect(inbox).toHaveCSS('opacity', '1')
      const panelBounds = await inbox.boundingBox()
      if (!panelBounds) throw new Error('Notification panel has no visible bounds')
      expect(panelBounds.x).toBeGreaterThanOrEqual(12)
      expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(378)
      await page.screenshot({
        path: '.context/workspace-notifications-mobile.png',
        animations: 'disabled',
      })
    } finally {
      await otherContext.close()
    }
  }
)

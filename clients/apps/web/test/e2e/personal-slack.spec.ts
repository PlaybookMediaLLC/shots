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
  openDisclosureFor,
} from './framework'
import { notificationSettingsSchema } from '../../lib/notifications/schema'

test.skip(
  !process.env.NOTIFICATIONS_E2E_PROVIDER_URL,
  'Requires the isolated Slack protocol fixture.'
)

test(
  'a creator connects and disconnects their own Slack DMs without changing shared Slack',
  { tag: '@journey' },
  async ({ app, browser, identity, page }) => {
    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()
    try {
      await signUpViaApi(identity, page)
      const workspace = z.object({ id: z.string() }).parse(
        await browserJson(page, '/api/auth/organization/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: identity.workspaceName,
            slug: `personal-slack-${randomUUID()}`,
          }),
        })
      )
      await grantWorkspacePlan(workspace.id, 'pro')
      const colleague = {
        ...identity,
        email: `slack-${identity.email}`,
        name: 'Slack notification member',
      }
      await signUpViaApi(colleague, memberPage)
      const invitation = await requestJson(page, '/api/auth/organization/invite-member', {
        email: colleague.email,
        role: 'creator',
        organizationId: workspace.id,
      })
      expect(invitation.status).toBe(200)
      const invitationId = z.object({ id: z.string() }).parse(invitation.body).id
      expect(
        (
          await requestJson(memberPage, '/api/auth/organization/accept-invitation', {
            invitationId,
          })
        ).status
      ).toBe(200)
      expect(
        (
          await requestJson(memberPage, '/api/auth/organization/set-active', {
            organizationId: workspace.id,
          })
        ).status
      ).toBe(200)

      await app.open('/workspace/notifications')
      await page.getByRole('button', { name: 'Delivery & Slack', exact: true }).click()
      await page.getByRole('button', { name: 'Connect Slack', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Local Slack fixture' })).toBeVisible()
      await page.getByRole('link', { name: 'Allow selected workspace' }).click()
      await expect(page.getByLabel('Slack workspace')).toBeVisible()
      const shared = notificationSettingsSchema.parse(
        await browserJson(page, '/api/workspace/notifications')
      ).connections[0]!

      await memberPage.goto('/workspace/notifications')
      await expect(
        memberPage.getByRole('button', { name: 'Delivery & Slack', exact: true })
      ).toHaveCount(0)
      await memberPage.getByRole('button', { name: 'Connect my Slack', exact: true }).click()
      await expect(memberPage.getByRole('heading', { name: 'Local Slack fixture' })).toBeVisible()
      expect(new URL(memberPage.url()).searchParams.get('scope')).toBe('chat:write')
      await memberPage.getByRole('link', { name: 'Allow selected workspace' }).click()
      await expect(
        memberPage.getByText(
          'Your Slack account is connected. Choose which direct messages to receive below.'
        )
      ).toBeVisible()
      await expect(
        memberPage.getByText('Fixture team · U012345 · Connected', { exact: true })
      ).toBeVisible()
      const settings = notificationSettingsSchema.parse(
        await browserJson(memberPage, '/api/workspace/notifications')
      )
      expect(settings.personalSlack?.slackUserId).toBe('U012345')
      expect(settings.personalSlack?.id).not.toBe(shared.id)
      const owner = notificationSettingsSchema.parse(
        await browserJson(page, '/api/workspace/notifications')
      )
      expect(owner.personalSlack).toBeNull()
      expect(
        (
          await browserRequest(
            page,
            `/api/workspace/notifications/slack/personal/${settings.personalSlack!.id}`,
            { method: 'DELETE' }
          )
        ).status
      ).toBe(404)
      const persisted = await db.query(
        'SELECT "userId",slack_user_id FROM platform_slack_personal_connection WHERE id=$1 AND "organizationId"=$2',
        [settings.personalSlack!.id, workspace.id]
      )
      expect(persisted.rows).toHaveLength(1)
      expect(persisted.rows[0].slack_user_id).toBe('U012345')

      const dmPreference = memberPage.getByLabel(
        'New comment on your draft: your Slack DM preference',
        { exact: true }
      )
      await openDisclosureFor(dmPreference)
      await dmPreference.check()
      await memberPage.getByRole('button', { name: 'Save my preferences', exact: true }).click()
      await expect(memberPage.getByText('Your preferences are saved.')).toBeVisible()
      expect(
        notificationSettingsSchema.parse(
          await browserJson(memberPage, '/api/workspace/notifications')
        ).preferences.events['comment.on_your_draft']?.slack
      ).toBe(true)
      await memberPage.getByRole('button', { name: 'Send test to my Slack', exact: true }).click()
      await expect(memberPage.getByText('Test queued. Its status appears below.')).toBeVisible()
      execFileSync(
        'docker',
        [
          'exec',
          process.env.NOTIFICATIONS_E2E_TEMPORAL_CONTAINER!,
          'temporal',
          'workflow',
          'execute',
          '--type',
          'platform-maintenance-v1',
          '--task-queue',
          'platform-maintenance',
          '--workflow-id',
          `personal-slack-${randomUUID()}`,
          '--input',
          '"notifications"',
        ],
        { stdio: 'pipe', timeout: 30_000 }
      )
      await expect(memberPage.getByText('Test delivered.', { exact: false })).toBeVisible()
      const receipt = await db.query(
        'SELECT status,provider_receipt FROM platform_notification_delivery WHERE "organizationId"=$1 AND channel=\'slack_dm\'',
        [workspace.id]
      )
      expect(receipt.rows).toHaveLength(1)
      expect(receipt.rows[0].status).toBe('SUCCEEDED')
      expect(receipt.rows[0].provider_receipt).toMatch(/^D012345:/)
      await memberPage.screenshot({ path: '.context/personal-slack-connected.png', fullPage: true })
      await memberPage.reload()
      await expect(
        memberPage.getByText('Fixture team · U012345 · Connected', { exact: true })
      ).toBeVisible()
      await memberPage.getByRole('button', { name: 'Disconnect my Slack', exact: true }).click()
      await expect(
        memberPage.getByText('Your Slack direct messages are disconnected.')
      ).toBeVisible()
      await memberPage.reload()
      await expect(memberPage.getByText('No personal Slack account connected.')).toBeVisible()
      const after = notificationSettingsSchema.parse(
        await browserJson(page, '/api/workspace/notifications')
      )
      expect(after.connections.find((c) => c.id === shared.id)?.health).toBe('CONNECTED')
      expect(
        (
          await db.query(
            'SELECT id FROM platform_slack_personal_connection WHERE "organizationId"=$1',
            [workspace.id]
          )
        ).rows
      ).toHaveLength(0)
    } finally {
      await memberContext.close()
    }
  }
)

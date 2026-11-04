import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import {
  browserJson,
  browserRequest,
  db,
  expect,
  grantWorkspacePlan,
  signUpViaApi,
  test,
} from './framework'
import {
  notificationSettingsSchema,
  notificationDeliverySchema,
} from '../../lib/notifications/schema'

test.skip(
  !process.env.NOTIFICATIONS_E2E_PROVIDER_URL,
  'Requires the isolated notification protocol fixture.'
)

for (const scenario of ['expired', 'uncertain'] as const) {
  test(
    `personal delivery recovery handles ${scenario} authorization or acceptance without duplicate sends`,
    { tag: '@journey' },
    async ({ app, identity, page }) => {
      const runWorker = () =>
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
            `notification-recovery-${randomUUID()}`,
            '--input',
            '"notifications"',
          ],
          { stdio: 'pipe', timeout: 30_000 }
        )
      await signUpViaApi(identity, page)
      const workspace = z.object({ id: z.string() }).parse(
        await browserJson(page, '/api/auth/organization/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: identity.workspaceName,
            slug: `recovery-${randomUUID()}`,
          }),
        })
      )
      await grantWorkspacePlan(workspace.id, 'pro')
      await app.open('/settings/notifications')
      await page.getByRole('switch', { name: 'Personal Slack messages', exact: true }).uncheck()
      await page.getByRole('button', { name: 'Save my preferences', exact: true }).click()
      await expect(page.getByText('Your preferences are saved.', { exact: true })).toBeVisible()
      expect(
        notificationSettingsSchema.parse(await browserJson(page, '/api/workspace/notifications'))
          .preferences.slackEnabled
      ).toBe(false)
      await page.getByRole('switch', { name: 'Personal Slack messages', exact: true }).check()
      await page.getByRole('button', { name: 'Save my preferences', exact: true }).click()
      await expect(page.getByText('Your preferences are saved.', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Connect my Slack', exact: true }).click()
      await page.getByRole('link', { name: 'Allow selected workspace' }).click()
      await expect(
        page.getByText(
          'Your Slack account is connected. Choose which direct messages to receive below.'
        )
      ).toBeVisible()
      const settings = notificationSettingsSchema.parse(
        await browserJson(page, '/api/workspace/notifications')
      )
      expect(
        settings.catalogue.find((event) => event.id === 'post.publish_failed')?.mandatoryFailure
      ).toBe(true)
      if (scenario === 'expired') {
        await db.query(
          'UPDATE platform_slack_installation SET expires_at=now()-interval \'1 minute\' WHERE id=(SELECT installation_id FROM platform_slack_personal_connection WHERE id=$1 AND "organizationId"=$2)',
          [settings.personalSlack!.id, workspace.id]
        )
      } else {
        const armed = await fetch(`${process.env.NOTIFICATIONS_E2E_PROVIDER_URL}/fail-next-slack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceName: identity.workspaceName }),
        })
        expect(armed.ok).toBe(true)
      }
      await page.getByRole('button', { name: 'Send test to my Slack', exact: true }).click()
      await expect(page.getByText('Test queued. Its status appears below.')).toBeVisible()
      runWorker()
      const list = z
        .object({ deliveries: z.array(notificationDeliverySchema) })
        .parse(await browserJson(page, '/api/workspace/notifications/deliveries?scope=personal'))
      const receipt = list.deliveries.find(
        (item) => item.kind === 'notification.test' && item.channel === 'slack_dm'
      )!
      expect(receipt.status).toBe(scenario === 'expired' ? 'BLOCKED' : 'UNCERTAIN')
      await app.reload()
      await page.getByText('Your email and Slack delivery history', { exact: true }).click()
      const card = page.getByRole('listitem', { name: `Delivery ${receipt.id}`, exact: true })
      await expect(card).toBeVisible()
      if (scenario === 'expired') {
        await expect(
          page.getByText('Fixture team · U012345 · Reconnect required', { exact: true })
        ).toBeVisible()
        await card.getByRole('button', { name: 'Retry safely', exact: true }).click()
        await expect(
          page.getByRole('alert').filter({ hasText: /reconnect required/i })
        ).toBeVisible()
        await page.getByRole('button', { name: 'Reconnect my Slack', exact: true }).click()
        await page.getByRole('link', { name: 'Allow selected workspace' }).click()
        await expect(
          page.getByText('Fixture team · U012345 · Connected', { exact: true })
        ).toBeVisible()
        await page.getByText('Your email and Slack delivery history', { exact: true }).click()
        await card.getByRole('button', { name: 'Retry safely', exact: true }).click()
        await expect(card.getByText('pending', { exact: true })).toBeVisible()
        runWorker()
      } else {
        await expect(card.getByText('Delivery unconfirmed', { exact: false })).toBeVisible()
        await expect(card.getByRole('button', { name: 'Retry safely', exact: true })).toHaveCount(0)
        expect(
          (
            await browserRequest(
              page,
              `/api/workspace/notifications/deliveries/${receipt.id}/recover`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'retry' }),
              }
            )
          ).status
        ).toBe(400)
        runWorker()
        await card.getByRole('button', { name: 'Confirm already delivered', exact: true }).click()
      }
      await expect(card.getByText('succeeded', { exact: true })).toBeVisible({ timeout: 30_000 })
      const action = scenario === 'expired' ? 'retry' : 'confirm_delivered'
      expect(
        (
          await browserRequest(
            page,
            `/api/workspace/notifications/deliveries/${receipt.id}/recover`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action }),
            }
          )
        ).status
      ).toBe(200)
      runWorker()
      const sink = z
        .object({ slack: z.array(z.object({ text: z.string() })) })
        .parse(await (await fetch(`${process.env.NOTIFICATIONS_E2E_PROVIDER_URL}/sink`)).json())
      expect(
        sink.slack.filter((item) => item.text.startsWith(`${identity.workspaceName}: `))
      ).toHaveLength(1)
      const audits = await db.query(
        'SELECT count(*)::int AS count FROM audit_log WHERE "organizationId"=$1 AND action=$2 AND "entityId"=$3',
        [workspace.id, `notification.delivery_${action}`, receipt.id]
      )
      expect(audits.rows[0].count).toBe(1)
      await page.screenshot({
        path: `.context/notification-recovery-${scenario}.png`,
        fullPage: true,
      })
    }
  )
}

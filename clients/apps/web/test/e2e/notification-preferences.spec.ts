import { randomUUID } from 'node:crypto'
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
import { notificationSettingsSchema } from '../../lib/notifications/schema'
import { socialSetSchema } from '../../lib/api/contracts/social-sets'

test(
  'independent channels, mixed groups, duplicate names, and stale saves persist correctly',
  { tag: '@journey' },
  async ({ app, context, identity, page }) => {
    await signUpViaApi(identity, page)
    const workspace = z.object({ id: z.string() }).parse(
      await browserJson(page, '/api/auth/organization/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: identity.workspaceName,
          slug: `notification-preferences-${randomUUID()}`,
        }),
      })
    )
    await grantWorkspacePlan(workspace.id, 'pro')
    const createSet = async () =>
      socialSetSchema.parse(
        await browserJson(page, '/api/v1/social-sets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Same brand', visibility: 'PRIVATE' }),
        })
      )
    const first = await createSet(),
      second = await createSet()
    const before = notificationSettingsSchema.parse(
      await browserJson(page, '/api/workspace/notifications')
    )
    // Seed the old public contract through the real API to exercise compatibility.
    const legacy = await browserRequest(page, '/api/workspace/notifications/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...before.preferences,
        socialSets: { [first.id]: { 'post.published': false } },
      }),
    })
    expect(legacy.status).toBe(200)
    await app.open('/settings/notifications')
    const firstRow = (event: string, channel: string) =>
      page.getByLabel(`Same brand (${first.id}): ${event}: your ${channel} preference`, {
        exact: true,
      })
    const secondRow = (event: string, channel: string) =>
      page.getByLabel(`Same brand (${second.id}): ${event}: your ${channel} preference`, {
        exact: true,
      })
    await expect(firstRow('Post published', 'in-app')).not.toBeChecked()
    await expect(secondRow('Post published', 'in-app')).toBeChecked()
    await firstRow('Post published', 'email').check()
    await expect(firstRow('Post published', 'in-app')).not.toBeChecked()
    await expect(firstRow('Post published', 'Slack DM')).not.toBeChecked()
    const group = page.getByLabel(
      `Same brand (${first.id}): All publishing activity: your in-app preferences`,
      { exact: true }
    )
    await expect(group).toHaveAttribute('aria-checked', 'mixed')
    await group.click()
    await expect(group).toBeChecked()
    await firstRow('Post published', 'in-app').uncheck()
    await expect(group).toHaveAttribute('aria-checked', 'mixed')
    await expect(secondRow('Post published', 'in-app')).toBeChecked()

    const commentGroup = page.getByLabel('All comments: your email preferences', { exact: true })
    await commentGroup.locator('xpath=ancestor::details').locator('summary').click()
    await commentGroup.click()
    await expect(commentGroup).not.toBeChecked()
    await expect(
      page.getByLabel('You were mentioned: your email preference', { exact: true })
    ).not.toBeChecked()
    await page
      .getByLabel('New comment on your draft: your email preference', { exact: true })
      .check()
    await expect(commentGroup).toHaveAttribute('aria-checked', 'mixed')
    const master = page.getByRole('switch', { name: 'Email notifications', exact: true })
    await master.uncheck()
    await expect(master).not.toBeChecked()
    await expect(firstRow('Post published', 'email')).toBeChecked()
    await expect(firstRow('Post published', 'email')).toBeEnabled()
    await firstRow('Auto-plug published', 'email').uncheck()
    await page.getByRole('button', { name: 'Save my preferences', exact: true }).click()
    await expect(page.getByText('Your preferences are saved.', { exact: true })).toBeVisible()
    const saved = notificationSettingsSchema.parse(
      await browserJson(page, '/api/workspace/notifications')
    )
    expect(saved.preferences.socialSetChannels?.[first.id]?.['post.published']).toEqual({
      inApp: false,
      email: true,
      slack: false,
    })
    expect(saved.preferences.socialSetChannels?.[second.id]).toBeUndefined()
    const persisted = await db.query(
      'SELECT social_set_channels FROM platform_notification_preference WHERE "organizationId"=$1',
      [workspace.id]
    )
    expect(persisted.rows[0].social_set_channels[first.id]['post.published'].email).toBe(true)
    await app.reload()
    await expect(firstRow('Post published', 'email')).toBeChecked()
    await expect(master).not.toBeChecked()
    await expect(secondRow('Post published', 'in-app')).toBeChecked()

    const sibling = await context.newPage()
    await sibling.goto('/settings/notifications')
    await expect(
      sibling.getByLabel(`Same brand (${first.id}): Post published: your email preference`, {
        exact: true,
      })
    ).toBeChecked()
    await firstRow('Post published', 'email').uncheck()
    await page.getByRole('button', { name: 'Save my preferences', exact: true }).click()
    await expect(page.getByText('Your preferences are saved.', { exact: true })).toBeVisible()
    await sibling
      .getByLabel(`Same brand (${second.id}): Post published: your in-app preference`, {
        exact: true,
      })
      .uncheck()
    await sibling.getByRole('button', { name: 'Save my preferences', exact: true }).click()
    await expect(
      sibling.getByRole('alert').filter({ hasText: 'changed in another tab' })
    ).toBeVisible()
    await sibling
      .getByRole('button', { name: 'Reload saved preferences and discard my changes', exact: true })
      .click()
    await expect(
      sibling.getByLabel(`Same brand (${first.id}): Post published: your email preference`, {
        exact: true,
      })
    ).not.toBeChecked()
    await expect(
      sibling.getByLabel(`Same brand (${second.id}): Post published: your in-app preference`, {
        exact: true,
      })
    ).toBeChecked()
    await sibling.close()
    await page.screenshot({ path: '.context/notification-preferences-desktop.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileChannels = page.getByRole('region', {
      name: `Same brand (${first.id}) notification channels`,
      exact: true,
    })
    await expect(mobileChannels).toBeVisible()
    await expect(
      mobileChannels.getByText('Scroll horizontally to see all delivery channels.')
    ).toBeVisible()
    await expect(firstRow('Post published', 'email')).toBeEnabled()
    await page.screenshot({ path: '.context/notification-preferences-mobile.png', fullPage: true })
  }
)

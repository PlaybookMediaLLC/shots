import { z } from 'zod'
import {
  acceptInvitation,
  browserRequest,
  db,
  enableTwoFactor,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  openWorkspaceSetting,
  requestJson,
  signUp,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const invitationSchema = z.object({ id: z.string() })

test(
  'a permission group takes a permission from a member, not from the owner, until it is deleted',
  { tag: '@smoke' },
  async ({ browser, identity, page }) => {
    const organizationId = await getActiveOrganizationId(page)
    const member = { ...identity, email: `group-${identity.email}`, name: 'E2E grouped member' }
    const inviteBody = { email: `invitee-${identity.email}`, organizationId, role: 'viewer' }
    const groupsPath = `/api/enterprise/permission-groups?organizationId=${organizationId}`
    const invitation = invitationSchema.parse(
      (
        await requestJson(page, '/api/auth/organization/invite-member', {
          email: member.email,
          organizationId,
          role: 'admin',
        })
      ).body
    )
    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()

    try {
      await signUp(member, memberPage)
      await acceptInvitation(memberPage, invitation.id)
      expect((await browserRequest(memberPage, groupsPath)).status).toBe(200)

      await enableTwoFactor(page, identity.password)
      const group = { deniedPermissions: ['member:read'], name: 'Refused on Pro', organizationId }
      const refused = await requestJson(page, '/api/enterprise/permission-groups', group)
      expect(refused.status).toBe(403)
      await expect
        .poll(() =>
          db.row('SELECT id FROM permission_group WHERE "organizationId" = $1', [organizationId])
        )
        .toBeNull()

      await grantWorkspacePlan(organizationId, 'enterprise')
      await openWorkspaceSetting(page, 'Permission groups')
      await page.getByLabel('New group name').fill('Contractors')
      for (const denied of ['member:read', 'member:invite', 'brand:manage']) {
        await page.getByLabel(denied).check()
      }
      await page.getByRole('button', { name: 'Create group' }).click()

      const groupName = page.getByLabel('Group name', { exact: true })
      await expect(groupName).toHaveValue('Contractors')
      await page.getByLabel(member.name).check()
      await page.getByLabel(identity.name).check()
      await page.getByRole('button', { name: 'Save group' }).click()
      await expect
        .poll(
          async () =>
            (
              await db.row<{ count: string }>(
                `SELECT count(*) FROM permission_group_member a
               JOIN permission_group g ON g.id = a."permissionGroupId"
               WHERE g."organizationId" = $1`,
                [organizationId]
              )
            )?.count
        )
        .toBe('2')

      expect((await browserRequest(memberPage, groupsPath)).status).toBe(403)
      expect((await browserRequest(page, groupsPath)).status).toBe(200)
      // Pages stop offering what the server would refuse.
      await openWorkspaceSetting(memberPage, 'White label')
      await expect(memberPage.getByLabel('Brand name')).toBeDisabled()
      await expect(memberPage.getByRole('button', { name: 'Save branding' })).toHaveCount(0)
      // Better Auth's own endpoints refuse the same member, not only the app's.
      expect(
        (await requestJson(memberPage, '/api/auth/organization/invite-member', inviteBody)).status
      ).toBe(403)
      expect(
        (
          await requestJson(memberPage, '/api/auth/api-key/create', {
            name: 'Denied',
            organizationId,
          })
        ).status
      ).toBe(403)

      await page.getByRole('button', { name: 'Delete group' }).click()
      await expect(groupName).toHaveCount(0)
      expect((await browserRequest(memberPage, groupsPath)).status).toBe(200)
      expect(
        await db.row(
          `SELECT id FROM audit_log WHERE "organizationId" = $1 AND action = 'permission_group.deleted'`,
          [organizationId]
        )
      ).not.toBeNull()
    } finally {
      await memberContext.close()
    }
  }
)

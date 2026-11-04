import { z } from 'zod'
import {
  browserRequest,
  db,
  type E2EIdentity,
  expect,
  getE2EUrl,
  openWorkspaceSetting,
  requestJson,
  signUp,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const invitationSchema = z.object({ id: z.string() })
const sessionSchema = z.object({
  session: z.object({ activeOrganizationId: z.string().nullable() }),
})

function getMemberIdentity(identity: E2EIdentity, prefix: string): E2EIdentity {
  return { ...identity, email: `${prefix}-${identity.email}`, name: `${prefix} recipient` }
}

async function createInvitation(page: Parameters<typeof openWorkspaceSetting>[0], email: string) {
  await openWorkspaceSetting(page, 'Members')
  await page.locator('input[name="email"]').fill(email)
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.getByText('Invitation created.')).toBeVisible()
  const invitation = await db.row<{ id: string }>(
    `SELECT id FROM invitation WHERE email = $1 AND status = 'pending'
       ORDER BY "createdAt" DESC LIMIT 1`,
    [email]
  )
  if (!invitation) throw new Error('Invitation was not created.')
  return invitationSchema.parse(invitation)
}

async function expectNoActiveWorkspace(
  page: Parameters<typeof openWorkspaceSetting>[0]
): Promise<void> {
  const response = await browserRequest(page, '/api/auth/get-session')
  const session = sessionSchema.parse(response.body)
  expect(session.session.activeOrganizationId).toBeNull()
}

async function expectInvitationRejection(
  page: Parameters<typeof openWorkspaceSetting>[0],
  invitationId: string,
  message: string
): Promise<void> {
  await page.goto(getE2EUrl(`/accept-invitation?invitationId=${invitationId}`))
  await expect(page.getByText(message, { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  const attempt = await requestJson(page, '/api/auth/organization/accept-invitation', {
    invitationId,
  })
  expect([404, 409]).toContain(attempt.status)
  await expect.poll(() => new URL(page.url()).pathname).toBe('/accept-invitation')
  await expectNoActiveWorkspace(page)
}

async function expireInvitation(invitationId: string): Promise<void> {
  await db.query(`UPDATE invitation SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [
    invitationId,
  ])
}

test(
  'an invitation accepts once for its intended recipient',
  { tag: '@smoke' },
  async ({ browser, identity, page }) => {
    const member = getMemberIdentity(identity, 'accepted')
    const invitation = await createInvitation(page, member.email)
    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()

    try {
      await signUp(member, memberPage)
      await memberPage.goto(getE2EUrl(`/accept-invitation?invitationId=${invitation.id}`))
      await memberPage.getByRole('button', { name: 'Accept invitation' }).click()
      await expect.poll(() => new URL(memberPage.url()).pathname).toBe('/settings')
      await memberPage.goto(getE2EUrl(`/accept-invitation?invitationId=${invitation.id}`))
      await expect(memberPage.getByText('This invitation has already been accepted.')).toBeVisible()
      await expect(memberPage.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
      expect(
        (
          await requestJson(memberPage, '/api/auth/organization/accept-invitation', {
            invitationId: invitation.id,
          })
        ).status
      ).toBe(409)
    } finally {
      await memberContext.close()
    }
  }
)

test('an invitation cannot be accepted by another user or after cancellation', async ({
  browser,
  identity,
  page,
}) => {
  const intendedMember = getMemberIdentity(identity, 'intended')
  const invitation = await createInvitation(page, intendedMember.email)
  const otherContext = await browser.newContext()
  const intendedContext = await browser.newContext()

  try {
    const otherPage = await otherContext.newPage()
    await signUp(getMemberIdentity(identity, 'other'), otherPage)
    await expectInvitationRejection(otherPage, invitation.id, 'unavailable for this account')
    await page.getByRole('button', { name: 'Resend' }).click()
    await expect(page.getByText('Invitation resent.')).toBeVisible()
    await page.getByRole('button', { name: 'Revoke' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke invitation' }).click()
    await expect(page.getByText('Invitation revoked.')).toBeVisible()

    const intendedPage = await intendedContext.newPage()
    await signUp(intendedMember, intendedPage)
    await expectInvitationRejection(intendedPage, invitation.id, 'has been revoked')
  } finally {
    await intendedContext.close()
    await otherContext.close()
  }
})

test('an expired invitation does not grant workspace access', async ({
  browser,
  identity,
  page,
}) => {
  const member = getMemberIdentity(identity, 'expired')
  const invitation = await createInvitation(page, member.email)
  await expireInvitation(invitation.id)
  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()

  try {
    await signUp(member, memberPage)
    await expectInvitationRejection(memberPage, invitation.id, 'has expired')
  } finally {
    await memberContext.close()
  }
})

test('a workspace cannot create duplicate active invitations', async ({ identity, page }) => {
  const member = getMemberIdentity(identity, 'duplicate')
  await createInvitation(page, member.email)
  await page.locator('input[name="email"]').fill(member.email)
  await page.getByRole('button', { name: 'Invite' }).click()
  await expect(page.getByText('This email already has a pending invitation.')).toBeVisible()
})

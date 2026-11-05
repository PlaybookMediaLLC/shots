import { z } from 'zod'
import {
  acceptInvitation,
  browserRequest,
  db,
  expect,
  getActiveOrganizationId,
  requestJson,
  signUp,
  test,
  trpcMutation,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const invitationSchema = z.object({ id: z.string() })

async function getMemberId(email: string, organizationId: string): Promise<string> {
  const user = await db.row<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email])
  if (!user) {
    throw new Error('The invited user was not created.')
  }
  const member = await db.row<{ id: string }>(
    'SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2',
    [organizationId, user.id]
  )
  if (!member) {
    throw new Error('The invitation did not create a workspace member.')
  }
  return member.id
}

test(
  'a role downgrade denies privileged actions and member removal revokes the active session',
  { tag: '@smoke' },
  async ({ browser, identity, page }) => {
    const organizationId = await getActiveOrganizationId(page)
    const member = { ...identity, email: `authorization-${identity.email}`, name: 'E2E creator' }
    const invitation = invitationSchema.parse(
      (
        await requestJson(page, '/api/auth/organization/invite-member', {
          email: member.email,
          organizationId,
          role: 'creator',
        })
      ).body
    )
    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()

    try {
      await signUp(member, memberPage)
      // Accepting navigates to /settings by itself; a second goto here raced
      // it and aborted. The helper waits for that navigation instead.
      await acceptInvitation(memberPage, invitation.id)
      const memberId = await getMemberId(member.email, organizationId)

      expect(
        (
          await requestJson(page, '/api/auth/organization/update-member-role', {
            memberId,
            organizationId,
            role: 'viewer',
          })
        ).status
      ).toBe(200)
      expect(
        (
          await trpcMutation(memberPage, 'brandKit.create', {
            definition: {
              colors: { accent: '#7047eb', background: '#ffffff', text: '#111111' },
              schemaVersion: 1,
              typography: { headingFamily: 'inter' },
            },
            name: 'Denied after downgrade',
            publish: false,
          })
        ).status
      ).toBe(403)

      expect(
        (
          await requestJson(page, '/api/auth/organization/remove-member', {
            memberIdOrEmail: memberId,
            organizationId,
          })
        ).status
      ).toBe(200)
      const session = await browserRequest(memberPage, '/api/auth/get-session')
      expect(session.body).toBeNull()
      expect((await browserRequest(memberPage, '/api/tenant/releases')).status).toBe(401)
    } finally {
      await memberContext.close()
    }
  }
)

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  browserRequest,
  db,
  expect,
  getE2EUrl,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
  trpcQuery,
  type E2EIdentity,
  type Page,
} from './framework'

const idSchema = z.object({ id: z.string() })

/** Signs a person up and gives them a workspace of their own. */
async function workspaceOf(person: E2EIdentity, page: Page): Promise<string> {
  await signUpViaApi(person, page)
  const created = await requestJson(page, '/api/auth/organization/create', {
    name: person.workspaceName,
    slug: `links-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  })
  expect(created.status).toBe(200)
  return idSchema.parse(created.body).id
}

test(
  'internal draft links grant nothing, a share link only reads, and removal ends access',
  { tag: '@journey' },
  async ({ browser, identity, page }) => {
    const org = await workspaceOf(identity, page)
    await grantWorkspacePlan(org, 'business')
    const text = `Internal launch note ${randomUUID()}`
    const draft = await requestJson(page, '/api/v1/content-drafts', {
      title: 'Launch',
      plainText: text,
    })
    expect(draft.status).toBe(201)
    const id = idSchema.parse(draft.body).id
    const shared = await requestJson(
      page,
      `/api/v1/content-drafts/${id}/share`,
      { enabled: true },
      'PUT'
    )
    expect(shared.status).toBe(200)
    const token = z.object({ shareToken: z.string() }).parse(shared.body).shareToken

    const outsiderContext = await browser.newContext()
    const memberContext = await browser.newContext()
    const guestContext = await browser.newContext()
    try {
      // Someone from another workspace holds both links.
      const outsider = await outsiderContext.newPage()
      // A paid workspace of their own, so a refusal is isolation and not a missing plan.
      await grantWorkspacePlan(
        await workspaceOf(
          {
            ...identity,
            email: `outsider-${identity.email}`,
            workspaceName: `Outsider ${identity.workspaceName}`,
          },
          outsider
        ),
        'business'
      )
      expect((await browserRequest(outsider, `/api/v1/content-drafts/${id}`)).status).toBe(404)
      expect((await outsider.goto(`/publish/${id}`))?.status()).toBe(404)
      await expect(outsider.getByText(text)).toHaveCount(0)
      // The share link reads the draft and grants nothing more; commenting through it is
      // covered by content-drafts-platform.spec.ts.
      await outsider.goto(`/d/${token}`)
      await expect(outsider.getByTestId('shared-draft')).toContainText(text)
      expect((await browserRequest(outsider, `/api/v1/content-drafts/${id}`)).status).toBe(404)
      const joined = await requestJson(outsider, '/api/auth/organization/accept-invitation', {
        invitationId: token,
      })
      expect([400, 403, 404]).toContain(joined.status)
      const organizations = await browserRequest(outsider, '/api/auth/organization/list')
      expect(organizations.status).toBe(200)
      expect(JSON.stringify(organizations.body)).not.toContain(org)

      // Without a session, the share link cannot schedule or read the internal draft.
      const scheduled = await guestContext.request.post(
        getE2EUrl(`/api/v1/content-drafts/${id}/schedule`),
        {
          data: {
            channelConnectionIds: [id],
            scheduledFor: new Date(Date.now() + 3_600_000).toISOString(),
            version: 1,
          },
          headers: { origin: new URL(getE2EUrl('/')).origin },
        }
      )
      expect(scheduled.status()).toBe(401)
      expect(
        (await guestContext.request.get(getE2EUrl(`/api/v1/content-drafts/${id}`))).status()
      ).toBe(401)

      // A member reads the internal link until they are removed, even after signing in again.
      const member = await memberContext.newPage()
      const email = `member-${identity.email}`
      await signUpViaApi({ ...identity, email }, member)
      const invitation = await requestJson(page, '/api/auth/organization/invite-member', {
        email,
        role: 'admin',
      })
      expect(invitation.status).toBe(200)
      const accepted = await requestJson(member, '/api/auth/organization/accept-invitation', {
        invitationId: idSchema.parse(invitation.body).id,
      })
      expect(accepted.status).toBe(200)
      expect((await browserRequest(member, `/api/v1/content-drafts/${id}`)).status).toBe(200)

      // An account in the owner's private profile is listed for the owner alone.
      const session = await browserRequest(page, '/api/auth/get-session')
      const ownerId = z.object({ user: idSchema }).parse(session.body).user.id
      const suffix = randomUUID().replaceAll('-', '').slice(0, 24)
      await db.query(
        `INSERT INTO social_set (id,"organizationId",name,visibility,"ownerUserId","publicSlug") VALUES ($1,$2,'Private profile','PRIVATE',$3,$4)`,
        [`cs${suffix}`, org, ownerId, `private-${suffix}`]
      )
      await db.query(
        `INSERT INTO channel_connection (id,"organizationId",provider,"externalAccountId",platform,"secretReference",status,"socialSetId","createdByUserId","updatedAt")
         VALUES ($1,$2,'social',$3,'x','SOCIAL_API_KEY','ACTIVE',$4,$5,now())`,
        [`cc${suffix}`, org, `private-account-${suffix}`, `cs${suffix}`, ownerId]
      )
      const listed = async (viewer: Page) => {
        const response = await trpcQuery(viewer, 'channelConnection.list')
        expect(response.status).toBe(200)
        return JSON.stringify(response.body).includes(`cc${suffix}`)
      }
      expect(await listed(page)).toBe(true)
      expect(await listed(member)).toBe(false)
      const memberId = z.object({ member: idSchema }).parse(accepted.body).member.id
      const removed = await requestJson(page, '/api/auth/organization/remove-member', {
        organizationId: org,
        memberIdOrEmail: memberId,
      })
      expect(removed.status).toBe(200)
      const signedIn = await requestJson(member, '/api/auth/sign-in/email', {
        email,
        password: identity.password,
      })
      expect(signedIn.status).toBe(200)
      expect((await browserRequest(member, `/api/v1/content-drafts/${id}`)).status).toBe(403)
      await member.goto(`/publish/${id}`)
      await expect(member.getByText(text)).toHaveCount(0)
    } finally {
      await outsiderContext.close()
      await memberContext.close()
      await guestContext.close()
    }
  }
)

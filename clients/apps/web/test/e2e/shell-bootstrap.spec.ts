import { z } from 'zod'
import {
  acceptInvitation,
  browserRequest,
  createWorkspace,
  type E2EIdentity,
  expect,
  getActiveOrganizationId,
  requestJson,
  signUp,
  test,
  trpcMutation,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const bootstrapSchema = z.object({
  capabilities: z.record(z.string(), z.boolean()),
  counters: z.object({ approvals: z.number(), attention: z.number() }),
  entitlements: z.object({
    features: z.record(z.string(), z.boolean()),
    plan: z.string(),
    status: z.string(),
  }),
  membership: z.object({ permissions: z.array(z.string()), role: z.string() }),
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  organizations: z.array(z.object({ id: z.string(), role: z.string() })),
  user: z.object({ email: z.string(), id: z.string() }),
  workspace: z.object({ locale: z.string(), timeZone: z.string() }),
})
const membersSchema = z.object({
  members: z.array(z.object({ id: z.string(), user: z.object({ email: z.string() }) })),
})
const apiKeySchema = z.object({ apiKey: z.object({ key: z.string().min(1) }) })
const workspaceSchema = z.object({ organization: z.object({ id: z.string() }) })
const invitationSchema = z.object({ id: z.string() })

async function getBootstrap(page: Parameters<typeof browserRequest>[0]) {
  const response = await browserRequest(page, '/api/v1/bootstrap', {
    headers: { 'x-playbook-client': 'wanta' },
  })
  expect(response.status).toBe(200)
  return { body: bootstrapSchema.parse(response.body), raw: JSON.stringify(response.body) }
}

test('a shell bootstraps from the stable API and never receives secrets', async ({
  identity,
  page,
}) => {
  const organizationId = await getActiveOrganizationId(page)
  const { body, raw } = await getBootstrap(page)

  expect(body.user.email).toBe(identity.email)
  expect(body.organization.id).toBe(organizationId)
  expect(body.organizations).toEqual([expect.objectContaining({ id: organizationId })])
  expect(body.membership.role).toBe('owner')
  expect(body.membership.permissions).toContain('member:invite')
  expect(body.entitlements.plan).toBe('pro')
  expect(body.capabilities).toMatchObject({ browserAutomation: false, publishing: false })
  for (const forbidden of ['secretReference', 'externalCustomerId', 'token', 'password']) {
    expect(raw).not.toContain(forbidden)
  }

  // An organization API key is a service credential, not a shell session.
  const key = apiKeySchema.parse(
    (await trpcMutation(page, 'apiKey.create', { name: 'Shell probe', scopes: ['artifact:read'] }))
      .body
  ).apiKey.key
  const withKey = await browserRequest(page, '/api/v1/bootstrap', {
    headers: { 'x-api-key': key },
  })
  expect(withKey.status).toBe(403)

  // Internal service routes reject a browser session.
  const internal = await requestJson(page, '/api/internal/tenant-outbox/e2e-probe/replay', {})
  expect(internal.status).toBe(401)
})

test('organization switching goes through membership checks', async ({
  browser,
  identity,
  page,
}) => {
  const firstId = await getActiveOrganizationId(page)
  const second = workspaceSchema.parse(
    (
      await trpcMutation(page, 'workspace.create', {
        name: `Second ${identity.workspaceName}`,
        slug: `second-${identity.email.split('@')[0]}`,
      })
    ).body
  ).organization

  // Creating a workspace activates it; reads of the other one are refused
  // until the shell activates it.
  expect((await getBootstrap(page)).body.organization.id).toBe(second.id)
  expect((await browserRequest(page, `/api/v1/organizations/${firstId}/members`)).status).toBe(403)
  const activated = await requestJson(page, `/api/v1/organizations/${firstId}/activate`, {})
  expect(activated.status).toBe(200)
  expect(bootstrapSchema.parse(activated.body).organization.id).toBe(firstId)
  expect(bootstrapSchema.parse(activated.body).organizations).toHaveLength(2)
  expect((await browserRequest(page, `/api/v1/organizations/${firstId}/members`)).status).toBe(200)

  const outsiderContext = await browser.newContext()
  const outsider = await outsiderContext.newPage()
  try {
    await createWorkspace(
      {
        ...identity,
        email: `outsider-${identity.email}`,
        workspaceName: `Outsider ${identity.workspaceName}`,
      },
      outsider
    )
    expect(
      (await requestJson(outsider, `/api/v1/organizations/${firstId}/activate`, {})).status
    ).toBe(404)
    expect((await browserRequest(outsider, `/api/v1/organizations/${firstId}`)).status).toBe(403)
    expect(
      (await browserRequest(outsider, `/api/v1/organizations/${firstId}/settings`)).status
    ).toBe(403)
  } finally {
    await outsiderContext.close()
  }
})

test(
  'a cached permission can show an action, but the server denies it after a role change',
  { tag: '@smoke' },
  async ({ browser, identity, page }) => {
    const organizationId = await getActiveOrganizationId(page)
    const member: E2EIdentity = {
      ...identity,
      email: `creator-${identity.email}`,
      name: 'E2E creator',
    }
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
      // Accepting navigates to /settings; a request sent before that lands is aborted.
      await acceptInvitation(memberPage, invitation.id)
      await expect
        .poll(async () => (await browserRequest(memberPage, '/api/v1/bootstrap')).status)
        .toBe(200)

      const cached = (await getBootstrap(memberPage)).body
      expect(cached.organization.id).toBe(organizationId)
      expect(cached.membership.permissions).toContain('release:create')

      const members = membersSchema.parse(
        (await browserRequest(page, `/api/v1/organizations/${organizationId}/members`)).body
      ).members
      const memberId = members.find((entry) => entry.user.email === member.email)?.id
      expect(memberId).toBeTruthy()
      expect(
        (
          await requestJson(page, '/api/auth/organization/update-member-role', {
            memberId,
            organizationId,
            role: 'viewer',
          })
        ).status
      ).toBe(200)

      // The shell still holds the old bootstrap; the server does not care.
      const denied = await trpcMutation(memberPage, 'release.create', {
        benefitStatement: 'Should be refused.',
        title: 'Stale permission release',
      })
      expect(denied.status).toBe(403)
      const refreshed = (await getBootstrap(memberPage)).body
      expect(refreshed.membership.role).toBe('viewer')
      expect(refreshed.membership.permissions).not.toContain('release:create')
    } finally {
      await memberContext.close()
    }
  }
)

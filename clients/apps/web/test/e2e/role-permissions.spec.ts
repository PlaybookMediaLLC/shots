import { z } from 'zod'
import {
  acceptInvitation,
  type Browser,
  browserRequest,
  type E2EIdentity,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  type Page,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const invitedRoles = [
  'admin',
  'creator',
  'approver',
  'publisher',
  'writer_publisher',
  'viewer',
] as const
const invitationSchema = z.object({ id: z.string() })

type InvitedRole = (typeof invitedRoles)[number]

type RoleContext = {
  browser: Browser
  email: string
  identity: E2EIdentity
  organizationId: string
  ownerPage: Page
  role: InvitedRole
}

async function inviteRole(input: RoleContext & { invitationId: string }): Promise<void> {
  const context = await input.browser.newContext()
  try {
    const memberPage = await context.newPage()
    // This spec asserts what each role may do, not how the account was
    // created, so invited members are created through the API. The sign-up
    // form stays covered by the specs that exist to exercise it.
    await signUpViaApi(
      { ...input.identity, email: input.email, name: `E2E ${input.role}` },
      memberPage
    )
    await acceptInvitation(memberPage, input.invitationId)
    await assertRolePermissions(memberPage, input.organizationId, input.role)
  } finally {
    // Without this the context leaks whenever an assertion fails, and the
    // abandoned browser competes for resources with the roles still to
    // run, which turns one slow role into a cascade of timeouts.
    await context.close()
  }
}

/**
 * Create the invitation on the owner's page.
 *
 * Kept separate from inviteRole, and never run concurrently, because every
 * helper here issues its request through `page.evaluate` so it carries the
 * session cookie. Two of these in flight on the same owner page share one
 * execution context, so anything that replaces that context rejects the
 * in-flight call with "Execution context was destroyed" no matter what the
 * endpoint would have returned. This is a POST, so browserRequest
 * deliberately does not retry it: a replayed invite could create a second
 * invitation.
 */
async function createInvitation(input: RoleContext): Promise<string> {
  const invitation = invitationSchema.parse(
    (
      await requestJson(input.ownerPage, '/api/auth/organization/invite-member', {
        email: input.email,
        organizationId: input.organizationId,
        role: input.role,
      })
    ).body
  )
  return invitation.id
}

async function assertRolePermissions(
  page: Page,
  organizationId: string,
  role: InvitedRole
): Promise<void> {
  const isAdmin = role === 'admin'
  const canCreateRelease = role === 'creator' || role === 'writer_publisher'
  const canManageWorkspace = isAdmin
  const canPublish = isAdmin || role === 'publisher' || role === 'writer_publisher'
  const [audit, brandKits, brandKitCreate, connections, invitation, releases, workspace] =
    await Promise.all([
      browserRequest(page, `/api/audit-logs?organizationId=${organizationId}`),
      trpcQuery(page, 'brandKit.list'),
      trpcMutation(page, 'brandKit.create', {
        definition: {
          colors: { accent: '#6d5dfc', background: '#ffffff', text: '#111111' },
          typography: { headingFamily: 'inter' },
        },
        name: `Role ${role} kit`,
        publish: true,
      }),
      trpcQuery(page, 'channelConnection.list'),
      trpcMutation(page, 'workspace.invite', {
        email: `invited-by-${role}-${organizationId}@example.test`,
        role: 'viewer',
      }),
      requestJson(
        page,
        '/api/tenant/releases',
        { benefitStatement: `Permission check for ${role}.`, title: `Role ${role} release` },
        'POST',
        { 'idempotency-key': `role-${role}-release` }
      ),
      trpcMutation(page, 'workspace.update', {
        name: `Denied ${role}`,
        slug: `denied-${role}-${organizationId.slice(-8).toLowerCase()}`,
      }),
    ])

  expect(audit.status).toBe(isAdmin ? 200 : 403)
  // Every member reads brand kits to apply them in the editor; only admins manage them.
  expect(brandKits.status).toBe(200)
  expect(brandKitCreate.status).toBe(isAdmin ? 200 : 403)
  expect(connections.status).toBe(canPublish ? 200 : 403)
  expect(invitation.status).toBe(isAdmin ? 200 : 403)
  expect(releases.status).toBe(canCreateRelease || isAdmin ? 201 : 403)
  expect(workspace.status).toBe(canManageWorkspace ? 200 : 403)

  // Content administration and publishing never grant financial authority.
  // These calls must stop at authorization before reaching Stripe.
  expect((await requestJson(page, '/api/billing/checkout', { plan: 'pro' })).status).toBe(403)
  expect((await requestJson(page, '/api/billing/credits', { pack: 'launch' })).status).toBe(403)
  expect(
    (await browserRequest(page, '/api/billing/checkout/return?session_id=fixture')).status
  ).toBe(403)
  expect(
    (await requestJson(page, '/api/v1/social-sets', { name: `Role ${role} set` })).status
  ).toBe(isAdmin ? 201 : 403)

  // New offers what the role may create and names who can grant the rest;
  // the server checks above still refuse those creations.
  const canEdit = isAdmin || role === 'creator' || role === 'writer_publisher'
  await page.goto('/home')
  await page
    .getByRole('complementary', { name: 'Primary navigation' })
    .getByRole('button', { name: 'New', exact: true })
    .click()
  const menu = page.getByRole('menu')
  for (const [item, allowed] of [
    ['Screenshot', canEdit],
    ['Canvas', canEdit],
    ['Post', canEdit],
    ['Campaign', canCreateRelease || isAdmin],
    ['Workflow', canManageWorkspace],
  ] as const) {
    const entry = menu.getByRole('menuitem', { name: item, exact: true })
    if (allowed) await expect(entry, `${role}: ${item}`).not.toHaveAttribute('aria-disabled')
    else await expect(entry, `${role}: ${item}`).toHaveAttribute('aria-disabled', 'true')
  }
  if (isAdmin) await expect(menu).not.toContainText('Not available to your')
  else await expect(menu).toContainText('Ask a workspace owner or admin for access.')
  await page.keyboard.press('Escape')
  // Home leaves out the starters the role cannot use instead of leading to a refusal.
  const starters = page.getByRole('region', { name: 'Start something new' })
  await expect(starters.getByRole('button', { name: /Write a post/ })).toHaveCount(canEdit ? 1 : 0)
  await expect(starters.getByText('Ask a workspace owner or admin for more access.')).toHaveCount(
    isAdmin ? 0 : 1
  )
}

test(
  'workspace roles permit only their assigned actions',
  { tag: '@journey' },
  async ({ browser, identity, page }) => {
    // One full sign-up, invitation, and permission sweep per role, in series;
    // under a loaded suite it ran past the default timeout.
    const organizationId = await getActiveOrganizationId(page)
    // The owner, six invited roles, and the admin's own invitation need eight
    // seats; Pro has five (docs/rfcs/035, Packaging).
    await grantWorkspacePlan(organizationId, 'business')

    // Roles are independent, so they run in pairs rather than one at a
    // time. Serially this was five sign-up and invitation round trips inside
    // a single test budget, which made the spec fail on accumulated latency
    // rather than on a permission regression. Running all five at once
    // instead would put five browser contexts on a two-core runner, so the
    // batch size trades a little wall time for stability.
    //
    // The invitations are created first, one at a time. They all run on the
    // owner's page, and concurrent page.evaluate calls there share a single
    // execution context, which is how this spec produced the "Execution
    // context was destroyed" flake. Only the per-role work below, which each
    // own a separate browser context, still runs in parallel.
    const invitations = new Map<InvitedRole, string>()
    for (const role of invitedRoles) {
      invitations.set(
        role,
        await createInvitation({
          browser,
          email: `${role}-${identity.email}`,
          identity,
          organizationId,
          ownerPage: page,
          role,
        })
      )
    }

    const concurrency = 2
    for (let index = 0; index < invitedRoles.length; index += concurrency) {
      await Promise.all(
        invitedRoles.slice(index, index + concurrency).map((role) => {
          const invitationId = invitations.get(role)
          if (!invitationId) throw new Error(`No invitation was created for the ${role} role.`)
          return inviteRole({
            browser,
            email: `${role}-${identity.email}`,
            identity,
            invitationId,
            organizationId,
            ownerPage: page,
            role,
          })
        })
      )
    }
  }
)

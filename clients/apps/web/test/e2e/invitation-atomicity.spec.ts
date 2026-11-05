import { z } from 'zod'
import { getWorkspaceLimit } from '@/lib/billing/plans'
import {
  browserRequest,
  db,
  expect,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

const invitationSchema = z.object({ id: z.string() })
const invitationState = z.object({ status: z.string() })
const sessionSchema = z.object({
  session: z.object({ activeOrganizationId: z.string().nullable() }),
})

test('a recipient declines explicitly, reloads the result, and cannot reuse the link', async ({
  browser,
  identity,
  page,
  workspace,
}, testInfo) => {
  const org = workspace.id
  const context = await browser.newContext()
  try {
    const recipient = await context.newPage()
    const email = `decline-${identity.email}`
    const invited = await requestJson(page, '/api/auth/organization/invite-member', {
      email,
      role: 'viewer',
      organizationId: org,
    })
    expect(invited.status).toBe(200)
    const { id } = invitationSchema.parse(invited.body)
    // The disposable delivery environment exposes its actual email sink. CI
    // environments without this sink still exercise all invitation mutations.
    const provider = process.env.NOTIFICATIONS_E2E_PROVIDER_URL
    if (provider) {
      const delivered = z
        .object({ auth: z.array(z.object({ to: z.string(), text: z.string() })) })
        .parse(await (await fetch(new URL('/sink', provider))).json())
      const receipts = delivered.auth.filter(
        (message) => message.to === email && message.text.includes(id)
      )
      expect(receipts).toHaveLength(1)
      expect(receipts[0].text).toContain(`/accept-invitation?invitationId=${id}`)
    }
    await signUpViaApi({ ...identity, email }, recipient)
    await recipient.goto(`/accept-invitation?invitationId=${id}`)
    const crossOrigin = await recipient.request.post(
      new URL('/api/auth/organization/reject-invitation', recipient.url()).toString(),
      { headers: { origin: 'https://untrusted.example' }, data: { invitationId: id } }
    )
    expect(crossOrigin.status()).toBe(403)
    expect(
      invitationState.parse(
        (await browserRequest(recipient, `/api/auth/organization/get-invitation?id=${id}`)).body
      ).status
    ).toBe('pending')
    await expect(
      recipient.getByRole('heading', { name: `Join ${identity.workspaceName}` })
    ).toBeVisible()
    await expect(
      recipient.getByText('cannot edit or publish drafts.', { exact: false })
    ).toBeVisible()
    await recipient.screenshot({ path: testInfo.outputPath('invitation-pending.png') })
    await recipient.getByRole('button', { name: 'Decline invitation', exact: true }).click()
    await expect(recipient.getByRole('status')).toHaveText('This invitation has been declined.')
    await recipient.reload()
    await expect(recipient.getByRole('status')).toHaveText('This invitation has been declined.')
    await expect(recipient.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
    const rejected = await requestJson(recipient, '/api/auth/organization/accept-invitation', {
      invitationId: id,
    })
    expect(rejected.status).toBe(409)
    expect(
      (
        await requestJson(recipient, '/api/auth/organization/reject-invitation', {
          invitationId: id,
        })
      ).status
    ).toBe(409)
    expect(
      sessionSchema.parse((await browserRequest(recipient, '/api/auth/get-session')).body).session
        .activeOrganizationId
    ).toBeNull()
    await recipient.setViewportSize({ width: 390, height: 844 })
    await recipient.screenshot({ path: testInfo.outputPath('invitation-declined-mobile.png') })
    const result = await db.query(
      'SELECT count(*)::int AS total FROM member WHERE "organizationId"=$1 AND "userId"=(SELECT id FROM "user" WHERE email=$2)',
      [org, email]
    )
    expect(result.rows[0].total).toBe(0)
  } finally {
    await context.close()
  }
})

test('a lost acceptance response is reconciled without resubmitting or duplicating membership', async ({
  browser,
  identity,
  page,
  workspace,
}) => {
  const org = workspace.id
  const context = await browser.newContext()
  try {
    const recipient = await context.newPage()
    const email = `lost-${identity.email}`
    const invited = await requestJson(page, '/api/auth/organization/invite-member', {
      email,
      role: 'writer_publisher',
      organizationId: org,
    })
    expect(invited.status).toBe(200)
    const { id } = invitationSchema.parse(invited.body)
    await signUpViaApi({ ...identity, email }, recipient)
    await recipient.goto(`/accept-invitation?invitationId=${id}`)
    let sends = 0
    await recipient.route(
      '**/api/auth/organization/accept-invitation',
      async (route) => {
        sends++
        const response = await route.fetch()
        expect(response.status()).toBe(200)
        await route.abort('failed')
      },
      { times: 1 }
    )
    await recipient.getByRole('button', { name: 'Accept invitation' }).click()
    await expect(
      recipient.getByText(
        'Refresh the invitation status to check the saved result before trying again.'
      )
    ).toBeVisible()
    await expect(recipient.getByRole('button', { name: 'Accept invitation' })).toBeDisabled()
    await recipient.getByRole('button', { name: 'Refresh invitation status' }).click()
    await expect(recipient.getByText('This invitation has already been accepted.')).toBeVisible()
    expect(sends).toBe(1)
    await recipient.getByRole('button', { name: 'Open workspace' }).click()
    await expect.poll(() => new URL(recipient.url()).pathname).toBe('/settings')
    const result = await db.query(
      'SELECT count(*)::int AS total FROM member WHERE "organizationId"=$1 AND "userId"=(SELECT id FROM "user" WHERE email=$2)',
      [org, email]
    )
    expect(result.rows[0].total).toBe(1)
    const audit = await db.query(
      'SELECT count(*)::int AS total FROM audit_log WHERE "organizationId"=$1 AND action=$2',
      [org, 'product.member_invitation_accepted']
    )
    expect(audit.rows[0].total).toBe(1)
  } finally {
    await context.close()
  }
})

test(
  'two real recipient sessions cannot both accept the final paid seat',
  { tag: '@journey' },
  async ({ browser, identity, page, workspace }) => {
    const org = workspace.id
    // The owner and seats - 2 members leave Pro one seat for two recipients.
    const seats = getWorkspaceLimit('pro', 'seats')
    if (seats === null) throw new Error('Pro must limit seats for this test.')
    await grantWorkspacePlan(org, 'business')
    const contexts = []
    const pending = []
    try {
      for (let index = 0; index < seats; index++) {
        const context = await browser.newContext()
        contexts.push(context)
        const recipient = await context.newPage()
        const email = `seat${index}-${identity.email}`
        const invited = await requestJson(page, '/api/auth/organization/invite-member', {
          email,
          role: 'viewer',
          organizationId: org,
        })
        expect(invited.status).toBe(200)
        const { id } = invitationSchema.parse(invited.body)
        await signUpViaApi({ ...identity, email }, recipient)
        if (index < seats - 2)
          expect(
            (
              await requestJson(recipient, '/api/auth/organization/accept-invitation', {
                invitationId: id,
              })
            ).status
          ).toBe(200)
        else pending.push({ recipient, id })
      }
      await grantWorkspacePlan(org, 'pro')
      const responses = await Promise.all(
        pending.map(({ recipient, id }) =>
          requestJson(recipient, '/api/auth/organization/accept-invitation', { invitationId: id })
        )
      )
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
      for (const [index, entry] of pending.entries()) {
        const result = await browserRequest(
          entry.recipient,
          `/api/auth/organization/get-invitation?id=${entry.id}`
        )
        expect(invitationState.parse(result.body).status).toBe(
          responses[index].status === 200 ? 'accepted' : 'pending'
        )
      }
      const result = await db.query(
        'SELECT count(*)::int AS total FROM member WHERE "organizationId"=$1',
        [org]
      )
      expect(result.rows[0].total).toBe(seats)
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
    }
  }
)

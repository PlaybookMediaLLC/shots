import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  browserRequest,
  db,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  openWorkspaceSetting,
  requestJson,
  signUpViaApi,
  test,
} from './framework'

const membership = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string(),
})
const acceptance = z.object({ member: membership })

test('Better Auth role, remove and leave commands persist audit and revoke old sessions', async ({
  app,
  browser,
  identity,
  page,
}) => {
  await signUpViaApi(identity, page)
  const created = await requestJson(page, '/api/auth/organization/create', {
    name: identity.workspaceName,
    slug: `membership-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  })
  expect(created.status).toBe(200)
  const org = z.object({ id: z.string() }).parse(created.body).id
  expect(await getActiveOrganizationId(page)).toBe(org)
  await grantWorkspacePlan(org, 'business')
  await page.goto('/settings/members', { waitUntil: 'domcontentloaded' })
  const contexts = []
  const members = []
  try {
    for (const name of ['removed', 'departing']) {
      const context = await browser.newContext()
      contexts.push(context)
      const memberPage = await context.newPage()
      const email = `${name}-${identity.email}`
      await signUpViaApi({ ...identity, email }, memberPage)
      const invited = await requestJson(page, '/api/auth/organization/invite-member', {
        email,
        role: 'viewer',
      })
      expect(invited.status).toBe(200)
      const invitationId = z.object({ id: z.string() }).parse(invited.body).id
      const accepted = await requestJson(memberPage, '/api/auth/organization/accept-invitation', {
        invitationId,
      })
      expect(accepted.status).toBe(200)
      members.push({ page: memberPage, email, ...acceptance.parse(accepted.body).member })
    }
    const [removed, departing] = members
    const update = { memberId: removed.id, role: 'publisher', organizationId: org }
    const untrusted = await page.request.post(
      new URL('/api/auth/organization/update-member-role', page.url()).toString(),
      { headers: { origin: 'https://untrusted.example' }, data: update }
    )
    expect(untrusted.status()).toBe(403)
    expect(
      (await requestJson(removed.page, '/api/auth/organization/update-member-role', update)).status
    ).toBe(403)
    expect(
      (
        await requestJson(page, '/api/auth/organization/update-member-role', {
          ...update,
          role: 'owner',
        })
      ).status
    ).toBe(400)
    expect(
      (await requestJson(page, '/api/auth/organization/leave', { organizationId: org })).status
    ).toBe(409)
    expect(
      (
        await requestJson(page, '/api/auth/organization/update-member-role', {
          ...update,
          organizationId: 'foreign-workspace',
        })
      ).status
    ).toBe(403)
    const changed = await requestJson(page, '/api/auth/organization/update-member-role', update)
    expect(changed.status).toBe(200)
    expect(acceptance.parse(changed.body).member).toEqual({
      id: removed.id,
      userId: removed.userId,
      organizationId: org,
      role: 'publisher',
    })
    // A repeated desired role is a no-op, not another activity event.
    expect(
      (await requestJson(page, '/api/auth/organization/update-member-role', update)).status
    ).toBe(200)
    await openWorkspaceSetting(page, 'Members')
    await expect(page.getByText(removed.email, { exact: true })).toBeVisible()
    await page.screenshot({ path: '.context/membership-before-removal.png' })
    const result = await requestJson(page, '/api/auth/organization/remove-member', {
      memberIdOrEmail: removed.email,
      organizationId: org,
    })
    expect(result.status).toBe(200)
    expect(acceptance.parse(result.body).member.id).toBe(removed.id)
    expect(
      (
        await requestJson(page, '/api/auth/organization/remove-member', {
          memberIdOrEmail: removed.id,
        })
      ).status
    ).toBe(404)
    expect(
      (await requestJson(removed.page, '/api/auth/organization/leave', { organizationId: org }))
        .status
    ).toBe(401)
    const left = await requestJson(departing.page, '/api/auth/organization/leave', {
      organizationId: org,
    })
    expect(left.status).toBe(200)
    expect(membership.parse(left.body).id).toBe(departing.id)
    expect(
      (await requestJson(departing.page, '/api/auth/organization/leave', { organizationId: org }))
        .status
    ).toBe(401)
    for (const member of members)
      expect((await browserRequest(member.page, '/api/auth/get-session')).body).toBeNull()
    await app.reload()
    await expect(page.getByText('1 member', { exact: true })).toBeVisible()
    await expect(page.getByText('No invitations are pending.', { exact: true })).toBeVisible()
    for (const member of members)
      await expect(page.getByText(member.email, { exact: true })).toHaveCount(0)
    await page.screenshot({ path: '.context/membership-after-removal.png' })
    const audits = z
      .array(z.object({ action: z.string(), total: z.number() }))
      .parse(
        (
          await db.query(
            'SELECT action, count(*)::int AS total FROM audit_log WHERE "organizationId"=$1 AND action IN ($2,$3,$4) GROUP BY action ORDER BY action',
            [org, 'product.member_role_changed', 'product.member_removed', 'product.member_left']
          )
        ).rows
      )
    expect(audits).toEqual([
      { action: 'product.member_left', total: 1 },
      { action: 'product.member_removed', total: 1 },
      { action: 'product.member_role_changed', total: 1 },
    ])
    const remaining = z
      .object({ total: z.number() })
      .parse(
        (
          await db.query('SELECT count(*)::int AS total FROM member WHERE "organizationId"=$1', [
            org,
          ])
        ).rows[0]
      )
    expect(remaining.total).toBe(1)
  } finally {
    for (const context of contexts) await context.close()
  }
})

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { workspaceCreationMemberSchema } from '../../../../packages/screenshot-studio-backend-sdk/src/workspace-creation'
import {
  db,
  expect,
  getActiveOrganizationId,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
} from './framework'

const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.iso.datetime(),
  logo: z.string().nullable(),
  metadata: z.object({ source: z.literal('test'), nested: z.object({ safe: z.literal(true) }) }),
  members: z.array(workspaceCreationMemberSchema).length(1),
})

test('Better Auth creation uses the atomic service without bypassing session or origin checks', async ({
  app,
  identity,
  page,
}) => {
  await app.open('/sign-in')
  const input = {
    name: `${identity.workspaceName} shared`,
    slug: `atomic-${randomUUID()}`,
    idempotencyKey: randomUUID(),
    keepCurrentActiveOrganization: true,
    logo: 'https://example.test/team.png',
    metadata: { source: 'test', nested: { safe: true } },
  }
  expect((await requestJson(page, '/api/auth/organization/create', input)).status).toBe(401)
  await signUpViaApi(identity, page)
  expect(
    (
      await requestJson(page, '/api/auth/sign-in/email', {
        email: identity.email,
        password: identity.password,
      })
    ).status
  ).toBe(200)
  const original = await trpcMutation(page, 'workspace.create', {
    name: identity.workspaceName,
    slug: `original-${randomUUID()}`,
    idempotencyKey: randomUUID(),
  })
  expect(original.status).toBe(200)
  const originalId = await getActiveOrganizationId(page)
  for (const headers of [{ origin: 'https://untrusted.example.test' }, { origin: 'null' }]) {
    const response = await page.request.post('/api/auth/organization/create', {
      data: input,
      headers,
    })
    expect(response.status()).toBe(403)
  }
  expect((await page.request.post('/api/auth/organization/create', { data: input })).status()).toBe(
    403
  )
  expect(
    (await requestJson(page, '/api/auth/organization/create', { ...input, userId: 'someone-else' }))
      .status
  ).toBe(400)
  const responses = await Promise.all([
    requestJson(page, '/api/auth/organization/create', input),
    requestJson(page, '/api/auth/organization/create', input),
  ])
  expect(responses.map((response) => response.status)).toEqual([200, 200])
  const first = organizationSchema.parse(responses[0].body)
  const second = organizationSchema.parse(responses[1].body)
  expect(second.id).toBe(first.id)
  expect(second.members[0].id).toBe(first.members[0].id)
  expect(first.members[0].role).toBe('owner')
  expect(first.members[0].organizationId).toBe(first.id)
  expect(first.logo).toBe(input.logo)
  expect(first.metadata).toEqual(input.metadata)
  expect(await getActiveOrganizationId(page)).toBe(originalId)
  expect(
    (
      await requestJson(page, '/api/auth/organization/create', {
        ...input,
        name: 'Different request',
      })
    ).status
  ).toBe(409)
  const counts = z
    .object({
      organizations: z.number(),
      owners: z.number(),
      receipts: z.number(),
      audits: z.number(),
    })
    .parse(
      (
        await db.query(
          `SELECT (SELECT count(*)::int FROM organization WHERE slug=$1) organizations,
        (SELECT count(*)::int FROM member WHERE "organizationId"=$2 AND role='owner') owners,
        (SELECT count(*)::int FROM platform_workspace_creation WHERE "organizationId"=$2) receipts,
        (SELECT count(*)::int FROM audit_log WHERE "organizationId"=$2 AND action='product.workspace_created') audits`,
          [input.slug, first.id]
        )
      ).rows[0]
    )
  expect(counts).toEqual({ organizations: 1, owners: 1, receipts: 1, audits: 1 })
  // The returned team is a real selectable workspace with a visible owner.
  expect(
    (await trpcMutation(page, 'workspace.setActive', { organizationId: first.id })).status
  ).toBe(200)
  await app.open('/settings/members')
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible()
  await expect(page.getByText('1 member', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Page content' }).getByText(identity.email, { exact: true })
  ).toBeVisible()
})

import { z } from 'zod'
import { workspaceCreationAttemptSchema } from '../../lib/workspace/creation-attempt'
import {
  db,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
} from './framework'

const creationRowsSchema = z.array(
  z.object({ id: z.string(), name: z.string(), role: z.literal('owner'), audits: z.number() })
)

test('retrying team creation after a lost committed response keeps one workspace', async ({
  app,
  identity,
  page,
}, testInfo) => {
  await signUpViaApi(identity, page)
  expect(
    (
      await requestJson(page, '/api/auth/sign-in/email', {
        email: identity.email,
        password: identity.password,
      })
    ).status
  ).toBe(200)
  await app.open('/onboarding')
  await page.getByRole('textbox', { name: 'Workspace name' }).fill(identity.workspaceName)
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible()
  const originalId = await getActiveOrganizationId(page)
  await grantWorkspacePlan(originalId, 'pro')
  await app.open('/settings/new-team')
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const name = `${identity.workspaceName} retry`
  await dialog.getByRole('textbox', { name: 'Workspace name' }).fill(name)
  const requests: string[] = []
  await page.route('**/api/trpc/workspace.create*', async (route) => {
    requests.push(route.request().postData() ?? '')
    if (requests.length === 1) {
      // The real backend commits; only delivery of its browser response fails.
      const committed = await route.fetch()
      expect(committed.ok()).toBe(true)
      await route.abort('connectionreset')
      return
    }
    await route.continue()
  })
  await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(dialog.getByRole('button', { name: 'Retry creation', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toHaveValue(name)
  const saved = z.object({ key: z.string(), raw: z.string() }).parse(
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find((key) =>
        key.startsWith('shots.workspace-creation.v1:')
      )
      return key ? { key, raw: sessionStorage.getItem(key) } : null
    })
  )
  const savedAttempt = workspaceCreationAttemptSchema.parse(JSON.parse(saved.raw))
  expect(await getActiveOrganizationId(page)).toBe(originalId)
  await page.screenshot({ path: testInfo.outputPath('workspace-creation-retry.png') })
  // Closing and reloading must retain this submitted intent, including its key.
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click()
  await app.reload()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toHaveValue(name)
  await expect(dialog.getByRole('textbox', { name: 'Workspace name' })).toHaveAttribute(
    'readonly',
    ''
  )
  await dialog.getByRole('button', { name: 'Retry creation', exact: true }).click()
  await expect(
    dialog.getByRole('heading', { name: 'Workspace created', exact: true })
  ).toBeVisible()
  expect(await getActiveOrganizationId(page)).toBe(originalId)
  await page.screenshot({ path: testInfo.outputPath('workspace-creation-next-steps.png') })
  await dialog.getByRole('button', { name: 'Invite members', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible()
  await expect(page.getByText('1 member', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Page content' }).getByText(identity.email, { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace-creation-recovered.png') })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toBe(requests[0])
  const committedId = await getActiveOrganizationId(page)
  expect(committedId).not.toBe(originalId)
  const result = await db.query(
    `SELECT o.id,o.name,m.role,
        (SELECT count(*)::int FROM audit_log a WHERE a."organizationId"=o.id AND a.action='product.workspace_created') AS audits
       FROM organization o
       JOIN member m ON m."organizationId"=o.id
       JOIN "user" u ON u.id=m."userId"
       WHERE u.email=$1 AND o.name=$2`,
    [identity.email, name]
  )
  expect(creationRowsSchema.parse(result.rows)).toEqual([
    { id: committedId, name, role: 'owner', audits: 1 },
  ])

  // Reusing a committed key with a changed name is a real backend conflict.
  // The user must be able to discard that rejected intent without an endless retry loop.
  await app.open('/settings/new-team')
  await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), {
    key: saved.key,
    raw: JSON.stringify({
      ...savedAttempt,
      input: { ...savedAttempt.input, name: `${name} changed` },
    }),
  })
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await dialog.getByRole('button', { name: 'Retry creation', exact: true }).click()
  await expect(
    dialog.getByText('This creation request was rejected.', { exact: false })
  ).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Retry creation', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('workspace-creation-conflict.png') })
  await dialog.getByRole('button', { name: 'Discard failed request' }).click()
  const freshName = dialog.getByRole('textbox', { name: 'Workspace name' })
  await expect(freshName).toHaveValue('')
  await expect(freshName).toBeEditable()
  expect(await page.evaluate((key) => sessionStorage.getItem(key), saved.key)).toBeNull()
  await freshName.fill('A fresh request is available')
  await expect(dialog.getByRole('button', { name: 'Create workspace', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(requests).toHaveLength(3)
  expect(await getActiveOrganizationId(page)).toBe(committedId)
  const counts = z
    .object({ count: z.number() })
    .parse(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM member m JOIN "user" u ON u.id=m."userId" WHERE u.email=$1',
          [identity.email]
        )
      ).rows[0]
    )
  expect(counts.count).toBe(2)
})

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  browserRequest,
  db,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  requestJson,
  signUpViaApi,
  test,
  trpcMutation,
} from './framework'

test('team dialog preserves the page, cancels safely, and validates mobile creation', async ({
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
  expect(
    (
      await trpcMutation(page, 'workspace.create', {
        name: identity.workspaceName,
        slug: `dialog-${randomUUID()}`,
        idempotencyKey: randomUUID(),
      })
    ).status
  ).toBe(200)
  const originalId = await getActiveOrganizationId(page)
  await grantWorkspacePlan(originalId, 'pro')
  await app.open('/settings')
  const originalField = page.getByRole('textbox', { name: 'Workspace name', exact: true })
  await originalField.fill('Unsaved current workspace name')
  const originalURL = page.url()
  let creationRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/trpc/workspace.create'))
      creationRequests++
  })
  const account = page.getByRole('button', { name: 'Open account menu' }).first()
  await account.click()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const name = dialog.getByRole('textbox', { name: 'Workspace name', exact: true })
  await expect(name).toBeFocused()
  await expect(
    dialog.getByText('Share profiles with colleagues or clients', { exact: false })
  ).toBeVisible()
  await expect(dialog.getByRole('link', { name: 'Learn about team roles' })).toHaveAttribute(
    'href',
    '/settings/roles'
  )
  await name.fill('Discard this draft name')
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('workspace-dialog-current-page.png'),
  })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(account).toBeFocused()
  expect(page.url()).toBe(originalURL)
  await expect(originalField).toHaveValue('Unsaved current workspace name')
  expect(await getActiveOrganizationId(page)).toBe(originalId)
  expect(creationRequests).toBe(0)
  await account.click()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(name).toHaveValue('')
  await name.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(account).toBeFocused()
  await originalField.fill(identity.workspaceName)

  // The settings launcher exposes the same dialog on a small screen.
  await page.setViewportSize({ width: 390, height: 844 })
  await app.open('/settings/new-team')
  const launcher = page
    .getByRole('main')
    .getByRole('button', { name: 'Create workspace', exact: true })
  await launcher.click()
  await expect(name).toBeFocused()
  const submit = dialog.getByRole('button', { name: 'Create workspace', exact: true })
  for (const invalid of [
    '',
    '   ',
    '\u200b\u200b',
    '\u0301\u0302',
    'a',
    'a'.repeat(101),
    'ab\u202e',
  ]) {
    await name.fill(invalid)
    await expect(submit).toBeDisabled()
  }
  expect(creationRequests).toBe(0)
  await name.fill('  Cafe\u0301 東京  ')
  await expect(submit).toBeEnabled()
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('workspace-dialog-mobile.png'),
  })
  await submit.click()
  await expect(dialog.getByRole('heading', { name: 'Workspace created' })).toBeVisible()
  await expect(dialog.getByText('Café 東京 is ready.', { exact: false })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Connect social accounts' })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Invite members' })).toBeEnabled()
  // Moving a profile is its own step: it starts from a profile in the current workspace.
  await expect(dialog.getByRole('link', { name: 'Move a profile here' })).toHaveAttribute(
    'href',
    /\/settings\/publishing-brands$/
  )
  expect(await getActiveOrganizationId(page)).toBe(originalId)
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('workspace-dialog-created-mobile.png'),
  })
  await dialog.getByRole('button', { name: 'Stay on this page' }).click()
  await expect(launcher).toBeFocused()
  expect(new URL(page.url()).pathname).toBe('/settings/new-team')
  expect(creationRequests).toBe(1)
  await page.setViewportSize({ width: 1280, height: 900 })
  await account.click()
  await expect(page.getByRole('button', { name: 'Switch to Café 東京', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Switch to Café 東京', exact: true })).toBeHidden()

  // An unreadable saved intent must not silently create another workspace.
  const session = z
    .object({ user: z.object({ id: z.string() }) })
    .parse((await browserRequest(page, '/api/auth/get-session')).body)
  await page.evaluate(
    (userId) =>
      sessionStorage.setItem(`shots.workspace-creation.v1:${userId}`, 'invalid saved intent'),
    session.user.id
  )
  await launcher.click()
  await expect(
    dialog.getByText('A saved creation request could not be read.', { exact: false })
  ).toBeVisible()
  await name.fill('Another workspace')
  await expect(submit).toBeDisabled()
  await dialog.getByRole('button', { name: 'Discard unreadable request' }).click()
  await expect(name).toHaveValue('')
  await expect(submit).toBeDisabled()
  await name.fill('Another workspace')
  await expect(submit).toBeEnabled()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(creationRequests).toBe(1)
  const rows = z
    .array(z.object({ name: z.string(), role: z.string() }))
    .parse(
      (
        await db.query(
          `SELECT o.name,m.role FROM organization o JOIN member m ON m."organizationId"=o.id JOIN "user" u ON u.id=m."userId" WHERE u.email=$1 ORDER BY o.name`,
          [identity.email]
        )
      ).rows
    )
  expect(rows).toEqual([
    { name: 'Café 東京', role: 'owner' },
    { name: identity.workspaceName, role: 'owner' },
  ])
})

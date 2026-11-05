import { DESIGN_DOCUMENT_VERSION } from '@/lib/design/document'
import { db, expect, grantWorkspacePlan, signUpViaApi, test, trpcMutation } from './framework'

test('warm project navigation reuses its list and rename invalidates it', async ({
  app,
  identity,
  page,
}) => {
  await signUpViaApi(identity, page)
  // Production builds require email verification; seed it only for this disposable identity.
  await db.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [identity.email])
  const signIn = await page.request.post('/api/auth/sign-in/email', {
    data: { email: identity.email, password: identity.password },
    headers: { origin: new URL(page.url()).origin },
  })
  expect(signIn.status()).toBe(200)
  const workspace = await trpcMutation(page, 'workspace.create', {
    name: identity.workspaceName,
    slug: identity.email.split('@')[0],
  })
  expect(workspace.status).toBe(200)
  const org = (workspace.body as { organization: { id: string } }).organization.id
  await grantWorkspacePlan(org, 'pro')
  const created = await trpcMutation(page, 'project.create', {
    name: 'Cache navigation project',
    document: { version: DESIGN_DOCUMENT_VERSION, image: { src: null } },
  })
  expect(created.status).toBe(200)
  let listRequests = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.includes('/api/trpc/') || !url.pathname.includes('project.list')) return
    // The rename dialog also checks name availability with a separate 100-item query.
    const inputs = JSON.parse(url.searchParams.get('input') ?? '{}') as Record<
      string,
      { json?: { limit?: number } }
    >
    if (Object.values(inputs).some((input) => input.json?.limit === 24)) listRequests++
  })
  await app.open('/projects')
  await expect(
    page.getByRole('link', { name: 'Cache navigation project', exact: true })
  ).toBeVisible()
  expect(listRequests).toBe(1)
  await page.locator('a[href="/workflows/overview"]').first().click()
  await expect(page.getByRole('heading', { name: 'Automate', exact: true })).toBeVisible()
  await page.locator('a[href="/library"]').first().click()
  await expect(
    page.getByRole('link', { name: 'Cache navigation project', exact: true })
  ).toBeVisible()
  expect(listRequests).toBe(1)
  await page
    .getByRole('button', { name: 'Actions for Cache navigation project', exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await page.getByLabel('Project name').fill('Renamed cached project')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(
    page.getByRole('link', { name: 'Renamed cached project', exact: true })
  ).toBeVisible()
  expect(listRequests).toBe(2)

  // Workspace switching uses full navigation, so the previous browser cache is discarded.
  const second = await trpcMutation(page, 'workspace.create', {
    name: 'Other workspace',
    slug: `other-${identity.email.split('@')[0]}`,
  })
  expect(second.status).toBe(200)
  await grantWorkspacePlan((second.body as { organization: { id: string } }).organization.id, 'pro')
  await app.open('/projects')
  await expect(page.getByRole('link', { name: 'Renamed cached project', exact: true })).toHaveCount(
    0
  )
  await expect(page.getByText('No projects yet', { exact: true })).toBeVisible()
})

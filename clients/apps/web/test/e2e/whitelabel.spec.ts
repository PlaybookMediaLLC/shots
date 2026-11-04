import {
  browserRequest,
  enableTwoFactor,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  openWorkspaceSetting,
  test,
} from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('an enterprise workspace brands the app and a lapsed plan restores Shots', async ({
  identity,
  page,
}) => {
  const organizationId = await getActiveOrganizationId(page)
  const home = page.getByRole('link', { name: 'Acme Home' })
  await enableTwoFactor(page, identity.password)

  const body = JSON.stringify({ brandName: 'Acme', organizationId })
  const refused = await browserRequest(page, '/api/enterprise/whitelabel', {
    body,
    headers: { 'content-type': 'application/json' },
    method: 'PUT',
  })
  expect(refused.status).toBe(403)

  await grantWorkspacePlan(organizationId, 'enterprise')
  await openWorkspaceSetting(page, 'White label')
  await page.getByLabel('Brand name').fill('Acme')
  await page.getByLabel('Primary color').fill('#0A66FF')
  await page.getByRole('button', { name: 'Save branding' }).click()
  await expect(home).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
      )
    )
    .toBe('#0A66FF')

  await grantWorkspacePlan(organizationId, 'pro')
  await page.reload()
  await expect(page.getByRole('link', { name: 'Shots Home' })).toBeVisible()
  await expect(home).toHaveCount(0)
})

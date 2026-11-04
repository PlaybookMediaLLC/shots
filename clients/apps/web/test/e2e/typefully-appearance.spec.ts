import { apiRequest, expect, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test('personal accent applies with contrast, survives reload and restores after a refused save or reset', async ({
  app,
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await app.open('/settings/appearance')
  const color = page.getByLabel('Accent color', { exact: true })
  await expect(color).toBeEnabled()
  await color.fill('#ffe500')
  await page.getByRole('button', { name: 'Apply accent', exact: true }).click()
  const accent = () => page.locator('html').evaluate((el) => el.style.getPropertyValue('--primary'))
  await expect.poll(accent).toBe('#ffe500')
  await expect
    .poll(
      async () =>
        ((await apiRequest(page, '/api/v1/me/preferences')).body as { accentColor: string })
          .accentColor
    )
    .toBe('#ffe500')
  await app.reload()
  await expect(color).toHaveValue('#ffe500')
  await expect.poll(accent).toBe('#ffe500')
  expect(
    await page.locator('html').evaluate((el) => el.style.getPropertyValue('--primary-foreground'))
  ).toBe('#000000')
  await page.route('**/api/v1/me/preferences', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 500, body: '{"error":"Save refused"}' })
      : route.continue()
  )
  await color.fill('#220044')
  await page.getByRole('button', { name: 'Apply accent', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Not saved' })).toBeVisible()
  await expect.poll(accent).toBe('#ffe500')
  await page.unroute('**/api/v1/me/preferences')
  await page.getByRole('button', { name: 'Reset accent', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Reset accent', exact: true })).toBeDisabled()
  await expect.poll(accent).toBe('')
  await app.reload()
  await expect.poll(accent).toBe('')
  expect(
    ((await apiRequest(page, '/api/v1/me/preferences')).body as { accentColor: string }).accentColor
  ).toBe('')
  expect(errors).toEqual([])
})

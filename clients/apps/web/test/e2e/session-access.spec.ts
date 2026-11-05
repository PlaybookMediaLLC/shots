import { expect, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test(
  'a signed-out user cannot open protected routes and can return after sign-in',
  { tag: '@smoke' },
  async ({ app, identity, page }) => {
    await app.openEditor()
    await page.getByRole('button', { name: 'Open account menu' }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toBe('/sign-in')

    await app.open('/settings')
    await expect.poll(() => new URL(page.url()).pathname).toBe('/sign-in')

    await app.open('/sign-in?callbackURL=/settings')
    await page.getByLabel('Email', { exact: true }).fill(identity.email)
    await page.getByLabel('Password').fill(identity.password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect.poll(() => new URL(page.url()).pathname).toBe('/settings')
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'General' })
    ).toBeVisible()
  }
)

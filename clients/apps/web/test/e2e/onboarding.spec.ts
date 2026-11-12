import { db, expect, signUp, test } from './framework'

test.beforeEach(async ({ app }) => {
  await app.open('/')
  await app.expectPath('/sign-in')
})

test(
  'a new user can create an account and workspace',
  { tag: '@smoke' },
  async ({ app, identity, page }) => {
    // The sign-up form; a production build signs in after it (no auto sign-in).
    await signUp(identity, page)
    await page.getByLabel('Workspace name').fill(identity.workspaceName)
    // Where they heard about Shots: optional, one answer, and "Other" takes a few words.
    // The enabled button means the form has hydrated, so the radio responds to a click.
    await expect(page.getByRole('button', { name: 'Create workspace' })).toBeEnabled()
    await page.getByRole('radio', { name: 'Other' }).click()
    await page.getByLabel('Where else did you hear about us?').fill('A conference talk')
    await page.getByRole('button', { name: 'Create workspace' }).click()

    // There is no free plan: onboarding ends by choosing one.
    await app.expectPath('/onboarding/plan')
    expect(
      await db.row<{ detail: string | null; source: string }>(
        `SELECT s.source, s.detail FROM platform_signup_source s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1`,
        [identity.email]
      )
    ).toEqual({ detail: 'A conference talk', source: 'other' })
    await expect(page.getByRole('heading', { name: 'Choose a plan' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Continue with free scheduling' })).toHaveCount(0)
    await app.open('/onboarding')
    await app.expectPath('/onboarding')
    await expect(page.getByRole('button', { name: 'Create workspace' })).toBeVisible()
  }
)

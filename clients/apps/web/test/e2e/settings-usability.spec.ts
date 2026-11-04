import { db, expect, openWorkspaceSetting, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test(
  'General keeps unsaved edits, warns on navigation, and discards to the last save',
  { tag: '@smoke' },
  async ({ app, page }) => {
    await openWorkspaceSetting(page, 'General')
    const description = page.getByLabel('Description', { exact: true })
    await description.fill('Keep this draft')
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
    page.once('dialog', (dialog) => dialog.dismiss())
    await page.getByRole('link', { name: 'Account', exact: true }).click()
    await expect(description).toHaveValue('Keep this draft')

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('link', { name: 'Account', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/account/)
    await openWorkspaceSetting(page, 'General')
    await expect(description).toHaveValue('Keep this draft')
    page.once('dialog', (dialog) => dialog.accept())
    await app.reload()
    await expect(description).toHaveValue('Keep this draft')
    await page.getByRole('button', { name: 'Save workspace' }).click()
    await expect(page.getByText('Workspace details updated.')).toBeVisible()
    await description.fill('Discard this edit')
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
    await expect(description).toHaveValue('Keep this draft')
    await app.reload()
    await expect(description).toHaveValue('Keep this draft')

    await page.getByLabel('Workspace slug').fill('INVALID SPACE!')
    await expect(page.locator('#workspace-slug-error')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save workspace' })).toBeDisabled()
    await page.getByRole('button', { name: 'Discard', exact: true }).click()
  }
)

test('brand colors retain the last valid preview and block publication until corrected', async ({
  page,
}) => {
  await openWorkspaceSetting(page, 'Brand voice & visual kits')
  await page.getByLabel('Visual brand kit name').fill('Validation test')
  await page.getByLabel('Accent', { exact: true }).fill('#123456')
  await page.getByLabel('Accent', { exact: true }).fill('not-a-color')
  await expect(page.getByLabel('Accent color picker')).toHaveValue('#123456')
  await expect(page.getByText('Enter a six-digit hex color, like #6d5dfc.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish visual brand kit' })).toBeDisabled()
  await page.getByLabel('Accent', { exact: true }).fill('#654321')
  await expect(page.getByRole('button', { name: 'Publish visual brand kit' })).toBeEnabled()
})

test('API keys start read-only and presets grant only their named capabilities', async ({
  page,
}) => {
  await openWorkspaceSetting(page, 'Developer API')
  await expect(page.locator('[id="scope-artifact:read"]')).toBeChecked()
  await expect(page.locator('button[id^="scope-"][data-state="checked"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Publishing', exact: true }).click()
  await expect(page.locator('[id="scope-post:schedule"]')).toBeChecked()
  await expect(page.locator('[id="scope-asset:write"]')).not.toBeChecked()
  await expect(page.getByRole('combobox', { name: 'Expires in', exact: true })).toHaveText(
    '30 days'
  )
})

test('an expired freshness window offers sign-in recovery back to Account', async ({
  identity,
  page,
}) => {
  await db.query(
    `UPDATE session SET "createdAt" = now() - interval '20 minutes' WHERE "userId" IN (SELECT id FROM "user" WHERE email = $1)`,
    [identity.email]
  )
  await openWorkspaceSetting(page, 'Account')
  await page.getByRole('button', { name: 'View signed-in devices' }).click()
  await expect(
    page.getByText('Confirm your sign-in to view and manage your sessions.')
  ).toBeVisible()
  await page.getByRole('link', { name: 'Verify identity', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).toBeVisible()
  await expect(page).toHaveURL(/callbackURL=%2Fsettings%2Faccount/)
})

test('SSO prerequisites explain the next steps before credentials are requested', async ({
  page,
}) => {
  await openWorkspaceSetting(page, 'SSO')
  await expect(
    page.getByText('Complete these steps to enter your provider credentials.')
  ).toBeVisible()
  await expect(page.getByLabel('Client secret')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Security settings', exact: true })).toBeVisible()
})

test('social-only accounts do not get an unusable authenticator password form', async ({
  identity,
  page,
}) => {
  // Local fixture: retain the authenticated session but give the account a social sign-in method.
  await db.query(
    `UPDATE account SET "providerId" = 'google', password = NULL WHERE "userId" IN (SELECT id FROM "user" WHERE email = $1) AND "providerId" = 'credential'`,
    [identity.email]
  )
  await openWorkspaceSetting(page, 'Security')
  await expect(
    page.getByText('Your sign-in provider does not give Shots a password.', { exact: false })
  ).toBeVisible()
  await expect(page.getByLabel('Current password')).toHaveCount(0)
})

test('settings search groups destinations and workspace creation lives in the workspace menu', async ({
  page,
}) => {
  await openWorkspaceSetting(page, 'General')
  const navigation = page.getByRole('navigation', { name: 'Settings sections', exact: true })
  await expect(navigation.getByText('Brand resources & content', { exact: true })).toBeVisible()
  await expect(navigation.getByRole('link', { name: 'Create workspace' })).toHaveCount(0)
  await navigation.getByRole('searchbox', { name: 'Search settings' }).fill('billing')
  await expect(navigation.getByRole('link')).toHaveCount(1)
  await navigation.getByRole('link', { name: 'Billing', exact: true }).click()
  await expect(page.getByText('Usage period', { exact: true })).toBeVisible()
  await expect(page.getByText(/Allowances reset .* at 00:00 UTC/)).toBeVisible()
  await navigation.getByRole('searchbox', { name: 'Search settings' }).fill('no-such-setting')
  await expect(navigation.getByText('No settings match your search.')).toBeVisible()
  await page.getByRole('button', { name: 'Open account menu' }).click()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Workspace name', exact: true })).toBeVisible()
})

test('a brand draft survives reload and is published only by the publish action', async ({
  app,
  page,
}) => {
  await openWorkspaceSetting(page, 'Brand voice & visual kits')
  await page.getByLabel('Visual brand kit name').fill('Reviewable brand')
  await page.getByLabel('Accent', { exact: true }).fill('#123456')
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  await expect(page.getByText('v1 · draft', { exact: true })).toBeVisible()
  await expect(page.getByText(/· active$/)).toHaveCount(0)
  await app.reload()
  await page.getByRole('button', { name: 'Resume draft', exact: true }).click()
  await expect(page.getByLabel('Accent', { exact: true })).toHaveValue('#123456')
  await page.getByLabel('Accent', { exact: true }).fill('invalid')
  const visualForm = page.getByLabel('Visual brand kit name').locator('xpath=ancestor::form')
  await visualForm.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(page.getByLabel('Accent', { exact: true })).toHaveValue('#123456')
  await page.getByRole('button', { name: 'Publish visual brand kit' }).click()
  await expect(page.getByText('v2 · active', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Publish visual brand kit' })).toBeDisabled()
})

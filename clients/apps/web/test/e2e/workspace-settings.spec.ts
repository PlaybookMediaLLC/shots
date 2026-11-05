import { chooseOption, expect, openWorkspaceSetting, test } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

test(
  'an owner can persist workspace, profile, and active brand-kit settings',
  { tag: '@smoke' },
  async ({ app, identity, page }) => {
    const workspaceName = `${identity.workspaceName} Updated`
    const workspaceSlug = `workspace-${identity.email.split('@')[0]}`

    await openWorkspaceSetting(page, 'General')
    await page.getByLabel('Workspace name').fill(workspaceName)
    await page.getByLabel('Workspace slug').fill(workspaceSlug)
    await page.getByRole('button', { name: 'Save workspace' }).click()
    await expect(page.getByText('Workspace details updated.')).toBeVisible()

    await openWorkspaceSetting(page, 'Account')
    await page.getByLabel('Name').fill('Updated E2E User')
    await page.getByLabel('Name').press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible()

    await openWorkspaceSetting(page, 'Brand voice & visual kits')
    await page.getByLabel('Visual brand kit name').fill('Launch system')
    await chooseOption(page.getByLabel('Primary typeface'), 'Inter')
    await page.getByRole('button', { name: 'Publish visual brand kit' }).click()
    await expect(page.getByText('Launch system', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('v1 · active')).toBeVisible()

    // Prohibited terms carry the reason an author sees when copy is refused.
    await page.getByLabel('Product description').fill('Invoicing for small teams')
    await page.getByLabel('Audience').fill('Finance leads')
    await page.getByLabel('Tone').fill('Plain and specific')
    await page.getByRole('button', { name: 'Add term' }).click()
    await page.getByLabel('Term 1', { exact: true }).fill('guaranteed')
    await page.getByLabel('Reason for term 1').fill('Legal does not allow promises')
    await chooseOption(page.getByLabel('How term 1 matches'), 'Anywhere, even inside a word')
    await page.getByRole('button', { name: 'Save brand voice' }).click()
    await expect(page.getByText('Brand voice saved.')).toBeVisible()

    await app.reload()
    await expect(page.getByLabel('Term 1', { exact: true })).toHaveValue('guaranteed')
    await expect(page.getByLabel('Reason for term 1')).toHaveValue('Legal does not allow promises')
    await expect(page.getByLabel('How term 1 matches')).toHaveText('Anywhere, even inside a word')

    await openWorkspaceSetting(page, 'Product pages')
    await page.getByLabel('Name', { exact: true }).fill('Billing')
    await page.getByLabel('URL', { exact: true }).fill('https://example.com/billing')
    await page.getByLabel('Feature tags').fill('invoices, approvals')
    await page.getByRole('button', { name: 'Add page' }).click()
    await expect(page.getByRole('heading', { name: 'Billing', level: 3 })).toBeVisible()
    await expect(page.getByText('Never captured')).toBeVisible()
    await expect(page.getByText('approvals', { exact: true })).toBeVisible()

    // The sidebar is an icon rail; the workspace name shows in the account menu.
    await page.getByRole('button', { name: 'Open account menu' }).click()
    await expect(page.getByText(`Workspace: ${workspaceName}`, { exact: true })).toBeVisible()
  }
)

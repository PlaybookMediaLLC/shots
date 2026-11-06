import {
  browserJson,
  expect,
  grantWorkspacePlan,
  signUpViaApi,
  test,
  trpcMutation,
  trpcQuery,
  chooseOption,
} from './framework'

test.use({ timezoneId: 'America/New_York' })

// @dev-server until fixed: on the production build the review-limit dialog ("cannot approve posts") does not appear.
test(
  'campaign validation, unsaved work, review limits and archive controls',
  { tag: ['@dev-server', '@journey'] },
  async ({ app, identity, page }) => {
    await signUpViaApi(identity, page)
    const organization = (await browserJson(page, '/api/auth/organization/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: identity.workspaceName, slug: `qa-${Date.now()}` }),
    })) as { id: string }
    await grantWorkspacePlan(organization.id, 'pro')
    await app.open('/campaigns/new')
    await page.getByRole('button', { name: 'More details', exact: true }).click()
    await chooseOption(page.getByLabel('Product', { exact: true }), 'Add a product…')
    await page.getByLabel('Product name').fill('QA Product')
    await page.getByLabel('App URL', { exact: false }).fill('example.com')
    await page.getByLabel('Release title').fill('Recurring invoices')
    await page.getByLabel('Why it matters').fill('Invoices send on schedule.')
    await page.getByLabel('Description').fill('<Stripe>')
    await page.getByRole('button', { name: 'Create campaign' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Description: Use plain text' })
    ).toBeVisible()
    const products = await trpcQuery(page, 'productSurface.list')
    expect(products.status).toBe(200)
    expect((products.body as { productSurfaces: unknown[] }).productSurfaces).toHaveLength(0)
    page.once('dialog', (dialog) => dialog.dismiss())
    await page.getByRole('link', { name: 'Campaigns', exact: true }).first().click()
    await expect(page.getByLabel('Release title')).toHaveValue('Recurring invoices')
    await page.getByLabel('Description').fill('Monthly recurring invoices.')
    await page.getByRole('button', { name: 'Create campaign' }).click()
    await expect(
      page.getByRole('heading', { name: 'Recurring invoices', exact: true })
    ).toBeVisible()
    const updatedTime = page.locator('time').first()
    const localTime = await updatedTime.evaluate((element) =>
      new Date(element.getAttribute('datetime')!).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    )
    await expect(updatedTime).toHaveText(localTime)
    const campaignId = new URL(page.url()).pathname.split('/').at(-1)!
    // Ask Shots can answer about this campaign without an onboarding profile.
    await page.getByRole('button', { name: 'Ask Shots' }).click()
    const panel = page.getByRole('dialog')
    await panel.getByLabel('Message').fill('Looks good, approve them.')
    await panel.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(panel.getByText(/cannot approve posts/)).toBeVisible({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    const copy = await trpcMutation(page, 'campaign.create', {
      name: 'Review limits',
      objective: 'Launch',
      posts: [{ channel: 'x', copy: 'x'.repeat(281) }],
    })
    expect(copy.status).toBe(200)
    const reviewCampaign = (copy.body as { campaign: { id: string } }).campaign.id
    await app.open(`/campaigns/${reviewCampaign}/copy`)
    await expect(page.getByRole('alert').filter({ hasText: '281/280' })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Submit for review', exact: true })
    ).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Submit all 1 for review' })).toBeDisabled()
    expect(
      (
        await trpcMutation(page, 'campaign.decideApproval', {
          campaignId: reviewCampaign,
          decision: 'submit',
        })
      ).status
    ).toBe(409)
    expect(
      (
        await trpcMutation(page, 'campaign.transition', {
          campaignId: reviewCampaign,
          status: 'ARCHIVED',
        })
      ).status
    ).toBe(200)
    await app.reload()
    await expect(page.getByText(/archived and read-only/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Submit/ })).toHaveCount(0)
    await app.open(`/campaigns/${campaignId}`)
    await page.getByRole('button', { name: 'Edit brief' }).click()
    await page.getByLabel('Description').fill('<Stripe>')
    await page.getByRole('button', { name: 'Save brief' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Description: Use plain text' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Edit brief' }).click()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Description: Use plain text' })
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await app.open('/campaigns')
    await expect(page.getByLabel('Product for quick draft')).toContainText('QA Product')
    await page.getByLabel('Search campaigns').fill('QA Product')
    await expect(page.getByRole('link', { name: /Recurring invoices/ })).toBeVisible()
  }
)

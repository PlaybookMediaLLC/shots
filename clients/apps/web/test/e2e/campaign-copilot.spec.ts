import { expect, test, trpcMutation } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

/**
 * Conversational campaign creation (RFC 028) end to end: one sentence on the
 * campaigns page starts a durable turn whose steps show in the panel, the
 * agent creates a campaign and drafts it through the launch pipeline, and the
 * panel links to it. After a reload, the campaign's "Ask Shots" reopens the
 * same conversation with the same messages and steps, read from the
 * database. The app runs with the scripted model (PLATFORM_AI_SCRIPTED=1);
 * the screenshot mock serves the product page.
 */

const MOCK = 'http://screenshot-mock:5678'
const RUN_TIMEOUT = 240_000

test(
  'one sentence becomes a drafted campaign with inspectable steps that survive a reload',
  { tag: '@journey' },
  async ({ app, page }) => {
    const profile = await trpcMutation(page, 'productSurface.create', {
      featureTags: ['recurring invoices'],
      name: 'Ledgerly',
      description: 'Invoices that send themselves.',
      url: `${MOCK}/product`,
    })
    expect(profile.status).toBe(200)

    await app.open('/campaigns')
    await page
      .getByLabel('What did you ship?')
      .fill('We just shipped recurring invoices. Market it.')
    await page.getByRole('button', { name: 'Draft a campaign' }).click()

    const panel = page.getByRole('dialog')
    await expect(
      panel.locator('p', { hasText: 'We just shipped recurring invoices. Market it.' })
    ).toBeVisible()
    await expect(panel.getByText('Find the product pages')).toBeVisible({ timeout: 60_000 })
    await expect(panel.getByRole('link', { name: 'Open campaign' })).toBeVisible({
      timeout: RUN_TIMEOUT,
    })
    await expect(panel.getByText(/I created the campaign/)).toBeVisible({ timeout: RUN_TIMEOUT })
    await expect(panel.getByText(/I assumed/)).toBeVisible()
    await expect(panel.getByText('Draft the spec, plan, and posts')).toBeVisible()
    await expect(panel.getByText('Done', { exact: true }).first()).toBeVisible()

    // The campaign is a page of its own, not chat text.
    await panel.getByRole('link', { name: 'Open campaign' }).click()
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/campaigns\/[^/]+$/)
    await expect(page.getByRole('heading', { name: /recurring invoices launch/i })).toBeVisible()

    // The database is the source of truth: a reload shows the same conversation.
    await app.reload()
    await page.getByRole('button', { name: 'Ask Shots' }).click()
    const reopened = page.getByRole('dialog')
    await expect(
      reopened.locator('p', { hasText: 'We just shipped recurring invoices. Market it.' })
    ).toBeVisible()
    await expect(reopened.getByText(/I created the campaign/)).toBeVisible()
    await expect(reopened.getByText('Create the campaign')).toBeVisible()
    await expect(reopened.getByText('Draft the spec, plan, and posts')).toBeVisible()
    await expect(reopened.getByRole('link', { name: 'Open campaign' })).toBeVisible()

    // Typing "approve" approves nothing: there is no approval tool.
    await reopened.getByLabel('Message').fill('Looks good, approve them.')
    await reopened.getByRole('button', { name: 'Send' }).click()
    await expect(reopened.getByText(/cannot approve posts/)).toBeVisible({ timeout: 60_000 })
  }
)

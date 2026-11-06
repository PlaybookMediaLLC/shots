import { db, expect, getActiveOrganizationId, grantWorkspacePlan, signUp, test } from './framework'

/**
 * Onboarding's product step end to end: a paid workspace without a product
 * profile is sent to it, a pasted URL is read into a cited profile by the
 * onboarding agent (the robots-disallowed page is skipped and the page that
 * tries a prompt injection is not believed), a correction locks its field,
 * and confirming produces a first campaign of exactly seven posts that the
 * founder approves in one action. The app runs with the scripted model
 * (PLATFORM_AI_SCRIPTED=1), the Go backend with the mock's fake OpenRouter,
 * and the screenshot mock serves the product site.
 */

const MOCK = 'http://screenshot-mock:5678'
const RUN_TIMEOUT = 180_000

test(
  'a pasted URL becomes a reviewed product profile and a first campaign of seven posts',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    await signUp(identity, page)
    await page.getByLabel('Workspace name').fill(identity.workspaceName)
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await app.expectPath('/onboarding/plan')
    const organizationId = await getActiveOrganizationId(page)
    await grantWorkspacePlan(organizationId, 'pro')
    // A paid workspace without a product profile goes on to the product step.
    await app.open('/onboarding/plan')
    // The product step is not warmed before the suite, so its first compile can be slow.
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 60_000 })
      .toBe('/onboarding/product')

    await page.getByLabel('Product URL').fill(`${MOCK}/acme`)
    await page.getByRole('button', { name: 'Read my site' }).click()
    await expect(page.getByRole('heading', { name: 'Does this look right?' })).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.getByLabel('Product name', { exact: true })).toHaveText('Acme')
    // The background read reaches the pricing page and fills in the plan.
    await expect(page.getByRole('status')).toContainText('Done', { timeout: 90_000 })
    await expect(page.getByLabel('Pricing', { exact: true })).toHaveText(/\$9 a month/)
    await expect(page.getByText(/From your site/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Edit who it is for' }).click()
    await page.getByLabel('Who it is for', { exact: true }).fill('Small creative agencies')
    await page.getByRole('button', { name: 'Save who it is for' }).click()
    await expect(page.getByLabel('Who it is for', { exact: true })).toHaveText(
      'Small creative agencies'
    )
    await page.getByRole('button', { name: 'Looks right' }).click()
    await expect(page.getByText('Creating your first 7 posts')).toBeVisible()

    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: RUN_TIMEOUT })
      .toMatch(/^\/campaigns\/[^/]+\/copy$/)
    const campaignId = new URL(page.url()).pathname.split('/')[2]!

    const profile = await db.row<{
      audience: string
      provenance: Record<string, { editedByUser: boolean; source: string; url?: string }>
    }>('SELECT * FROM product_profile WHERE "organizationId" = $1', [organizationId])
    // The about page tried a prompt injection; nothing from it reached the profile.
    expect(JSON.stringify(profile)).not.toContain('free forever')
    expect(profile?.audience).toBe('Small creative agencies')
    expect(profile?.provenance.audience?.editedByUser).toBe(true)
    expect(profile?.provenance.name).toMatchObject({ editedByUser: false, source: 'automated' })
    expect(profile?.provenance.pricingNote?.url).toBe(`${MOCK}/pricing`)

    const release = await db.row<{ sourceUrls: string[]; title: string }>(
      `SELECT r.title, r."sourceUrls" FROM release r JOIN campaign c ON c."releaseId" = r.id
       WHERE c.id = $1`,
      [campaignId]
    )
    expect(release?.title).toBe('Acme launch')
    expect(release?.sourceUrls).not.toContain(`${MOCK}/private/admin`)
    expect(release?.sourceUrls).not.toContain(`${MOCK}/privacy`)
    expect(release?.sourceUrls[0]).toBe(`${MOCK}/pricing`)

    const posts = await db.rows<{ channel: string }>(
      'SELECT channel FROM campaign_post WHERE "campaignId" = $1',
      [campaignId]
    )
    expect(posts).toHaveLength(7)
    expect(new Set(posts.map((post) => post.channel))).toEqual(new Set(['x', 'linkedin']))

    await page.getByRole('button', { name: /^Submit all 7 for review$/ }).click()
    await expect(page.getByText(/sent for review$/)).toBeVisible()
    await page.getByRole('button', { name: /^Approve all 7$/ }).click()
    await expect(page.getByText(/posts? approved$/)).toBeVisible()
  }
)

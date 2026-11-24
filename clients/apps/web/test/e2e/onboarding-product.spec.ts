import {
  db,
  expect,
  getActiveOrganizationId,
  getE2EUrl,
  grantWorkspacePlan,
  signUp,
  test,
  trpcMutation,
  waitForHydration,
} from './framework'
import { z } from 'zod'

/**
 * Onboarding's product step end to end: a paid workspace without a product
 * profile is sent to it, a pasted URL is read into a cited profile by the
 * onboarding agent (the robots-disallowed page is skipped and the page that
 * tries a prompt injection is not believed), a correction locks its field,
 * and confirming opens a saved campaign whose spec and plan require explicit
 * review decisions before any content is produced. The app runs with the scripted model
 * (PLATFORM_AI_SCRIPTED=1), the Go backend with the mock's fake OpenRouter,
 * and the screenshot mock serves the product site.
 */

const MOCK = 'http://screenshot-mock:5678'
const RUN_TIMEOUT = 180_000

test('first-campaign creation recovers a lost response and concurrent tabs', async ({
  app,
  page,
  workspace,
}) => {
  const saved = await trpcMutation(page, 'productProfile.upsert', {
    name: 'Retry product',
    url: 'https://retry.example.test',
    summary: 'A product to explain.',
  })
  expect(saved.status).toBe(200)
  await app.open('/home')
  const other = await page.context().newPage()
  await other.goto(getE2EUrl('/home'))
  let committed = false
  await page.route(
    '**/api/trpc/onboarding.startCampaign',
    async (route) => {
      const response = await route.fetch()
      committed = response.status() === 200
      await route.abort('failed')
    },
    { times: 1 }
  )
  try {
    const [lost, concurrent] = await Promise.allSettled([
      trpcMutation(page, 'onboarding.startCampaign', { pages: [] }),
      trpcMutation(other, 'onboarding.startCampaign', { pages: [] }),
    ])
    expect(lost.status).toBe('rejected')
    expect(committed).toBe(true)
    if (concurrent.status !== 'fulfilled') throw concurrent.reason
    expect(concurrent.value.status, JSON.stringify(concurrent.value.body)).toBe(200)
    const result = z.object({ campaignId: z.string() }).parse(concurrent.value.body)
    await app.reload()
    const retry = await trpcMutation(page, 'onboarding.startCampaign', { pages: [] })
    expect(retry.status).toBe(200)
    expect(z.object({ campaignId: z.string() }).parse(retry.body).campaignId).toBe(
      result.campaignId
    )
    expect(
      await db.rows('SELECT id FROM campaign WHERE "organizationId"=$1', [workspace.id])
    ).toEqual([{ id: result.campaignId }])
    expect(
      await db.rows('SELECT id FROM release WHERE "organizationId"=$1', [workspace.id])
    ).toHaveLength(1)
    expect(
      await db.rows('SELECT id FROM product_surface WHERE "organizationId"=$1', [workspace.id])
    ).toHaveLength(1)
    await app.open(`/campaigns/${result.campaignId}/spec`)
    await expect(page.getByRole('button', { name: 'Draft spec', exact: true })).toBeVisible()
  } finally {
    await other.close()
  }
})

test(
  'a confirmed product opens a campaign whose generated spec and plan need explicit approval',
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
    // Scoped: the review shows other status lines, such as "Loading findings…", as the read ends.
    await expect(
      page.getByRole('region', { name: 'Background read' }).getByRole('status')
    ).toContainText('Done', { timeout: 90_000 })
    await expect(page.getByLabel('Pricing', { exact: true })).toHaveText(/\$9 a month/)
    await expect(page.getByText(/From your site/).first()).toBeVisible()
    await page.getByRole('button', { name: 'Edit who it is for' }).click()
    await page.getByLabel('Who it is for', { exact: true }).fill('Small creative agencies')
    await page.getByRole('button', { name: 'Save who it is for' }).click()
    await expect(page.getByLabel('Who it is for', { exact: true })).toHaveText(
      'Small creative agencies'
    )
    await page.getByRole('button', { name: 'Looks right' }).click()

    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: RUN_TIMEOUT })
      .toMatch(/^\/campaigns\/[^/]+\/spec$/)
    const campaignId = new URL(page.url()).pathname.split('/')[2]!
    await waitForHydration(page)

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

    const release = await db.row<{ id: string; sourceUrls: string[]; title: string }>(
      `SELECT r.id, r.title, r."sourceUrls" FROM release r JOIN campaign c ON c."releaseId" = r.id
       WHERE c.id = $1`,
      [campaignId]
    )
    expect(release?.title).toBe('Acme launch')
    expect(release?.sourceUrls).not.toContain(`${MOCK}/private/admin`)
    expect(release?.sourceUrls).not.toContain(`${MOCK}/privacy`)
    expect(release?.sourceUrls[0]).toBe(`${MOCK}/pricing`)

    if (!release) throw new Error('The first campaign must retain its release.')
    expect(
      await db.rows('SELECT id FROM release_spec WHERE "releaseId" = $1', [release.id])
    ).toEqual([])
    expect(
      await db.rows('SELECT id FROM campaign_plan WHERE "campaignId" = $1', [campaignId])
    ).toEqual([])
    expect(
      await db.rows('SELECT id FROM campaign_post WHERE "campaignId" = $1', [campaignId])
    ).toEqual([])

    const started = page.waitForResponse((response) =>
      response.url().includes('/api/trpc/launch.spec.generate')
    )
    await page.getByRole('button', { name: 'Draft spec', exact: true }).click()
    expect((await started).status()).toBe(200)
    await expect(page.getByRole('button', { name: 'Approve spec', exact: true })).toBeVisible({
      timeout: RUN_TIMEOUT,
    })
    expect(
      await db.row(
        'SELECT status FROM release_spec WHERE "releaseId" = $1 ORDER BY version DESC LIMIT 1',
        [release.id]
      )
    ).toEqual({ status: 'DRAFT' })
    // Refresh resumes the saved review without implicitly approving the generated version.
    await app.reload()
    await expect(page.getByRole('button', { name: 'Approve spec', exact: true })).toBeVisible()
    page.once('dialog', async (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Approve spec', exact: true }).click()
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
    expect(
      await db.row(
        'SELECT status FROM release_spec WHERE "releaseId" = $1 ORDER BY version DESC LIMIT 1',
        [release.id]
      )
    ).toEqual({ status: 'APPROVED' })

    await app.open(`/campaigns/${campaignId}/plan`)
    await page.getByRole('button', { name: 'Plan campaign', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeVisible({
      timeout: RUN_TIMEOUT,
    })
    expect(
      await db.row(
        'SELECT status FROM campaign_plan WHERE "campaignId" = $1 ORDER BY version DESC LIMIT 1',
        [campaignId]
      )
    ).toEqual({ status: 'DRAFT' })
    await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
    expect(
      await db.row(
        'SELECT status FROM campaign_plan WHERE "campaignId" = $1 ORDER BY version DESC LIMIT 1',
        [campaignId]
      )
    ).toEqual({ status: 'APPROVED' })
    expect(
      await db.rows('SELECT id FROM campaign_post WHERE "campaignId" = $1', [campaignId])
    ).toEqual([])
  }
)

import {
  browserRequest,
  db,
  type E2EIdentity,
  expect,
  getActiveOrganizationId,
  grantWorkspacePlan,
  type Page,
  signUp,
  test,
  trpcQuery,
} from './framework'

/**
 * The onboarding agent end to end (docs/rfcs/034-background-onboarding-agent.md):
 * a pasted URL becomes a reviewable draft in under ten seconds, the
 * background run reports progress until it has read the site and derived the
 * ideal customer profile, the founder accepts a field, and a re-run of the
 * unchanged site reads nothing and calls no model. Every external call is
 * local: the screenshot mock serves the product site and a fake OpenRouter,
 * and the enrichment providers that would reach the internet are off.
 */

const MOCK = 'http://screenshot-mock:5678'
/** The mock's host on a port nothing serves: a site that cannot be reached. */
const UNREADABLE = 'http://screenshot-mock:5677/'
const RUN_TIMEOUT = 120_000

type RunRow = {
  completedStages: string[]
  fastPathMs: number
  id: string
  pagesDiscovered: number
  pagesProcessed: number
  pagesSkipped: number
  progress: number
  status: string
  tokensUsed: number
}

/** A paid workspace without a product profile, on the product step. */
async function openProductStep(identity: E2EIdentity, page: Page): Promise<string> {
  await signUp(identity, page)
  await page.getByLabel('Workspace name').fill(identity.workspaceName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/onboarding/plan')
  const organizationId = await getActiveOrganizationId(page)
  await grantWorkspacePlan(organizationId, 'pro')
  await page.goto('/onboarding/plan')
  // The product step is not warmed before the suite, so its first compile can be slow.
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 60_000 })
    .toBe('/onboarding/product')
  await expect(page.getByLabel('Product URL')).toBeVisible({ timeout: 60_000 })
  return organizationId
}

async function runs(organizationId: string): Promise<RunRow[]> {
  return await db.rows<RunRow>(
    'SELECT * FROM onboarding_run WHERE "organizationId" = $1 ORDER BY "createdAt"',
    [organizationId]
  )
}

test(
  'a pasted URL is drafted in under ten seconds, enriched in the background, and accepted',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    const organizationId = await openProductStep(identity, page)

    await page.getByLabel('Product URL').fill(`${MOCK}/acme`)
    const clicked = Date.now()
    await page.getByRole('button', { name: 'Read my site' }).click()
    await expect(page.getByRole('heading', { name: 'Does this look right?' })).toBeVisible({
      timeout: 10_000,
    })
    expect(Date.now() - clicked).toBeLessThan(10_000)
    await expect(page.getByLabel('Product name', { exact: true })).toHaveText('Acme')

    // Progress runs to 100 and never goes back while the background run reads the site.
    const overall = page.getByRole('progressbar', { name: 'Overall progress' })
    const seen: number[] = []
    await expect
      .poll(
        async () => {
          seen.push(Number(await overall.getAttribute('aria-valuenow')))
          return seen.at(-1)
        },
        { intervals: [500], timeout: RUN_TIMEOUT }
      )
      .toBe(100)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    await expect(page.getByRole('status')).toContainText('Done')

    // The background run read the pricing page and derived the ideal customer.
    await expect(page.getByLabel('Pricing', { exact: true })).toHaveText(/\$9 a month/)
    await expect(page.getByLabel('Who buys it', { exact: true })).toContainText('Agency owner')
    await expect(page.getByText(/From your site · \d+% sure/).first()).toBeVisible()

    await page.getByRole('button', { name: 'Accept pains' }).click()
    await expect(page.getByRole('button', { name: 'Accept pains' })).toBeDisabled()
    await expect(page.getByText('Accepted by you')).toBeVisible()

    const [run] = await runs(organizationId)
    expect(run).toMatchObject({ progress: 100, status: 'completed' })
    expect(run!.fastPathMs).toBeLessThan(10_000)
    // pricing, features, about, and the blog post; privacy and the robots-disallowed page are not read.
    expect(run!.pagesDiscovered).toBe(4)
    expect(run!.completedStages).toEqual(
      expect.arrayContaining(['fast_path', 'crawl', 'classify', 'enrich', 'icp', 'brand'])
    )
    const pages = await db.rows<{ pageType: string; url: string }>(
      'SELECT url, "pageType" FROM page_knowledge WHERE "organizationId" = $1',
      [organizationId]
    )
    expect(pages.map((stored) => stored.url)).not.toContain(`${MOCK}/private/admin`)
    expect(pages.find((stored) => stored.url === `${MOCK}/pricing`)?.pageType).toBe('pricing')
    const profile = await db.row<Record<string, unknown>>(
      'SELECT * FROM product_profile WHERE "organizationId" = $1',
      [organizationId]
    )
    // The about page tried a prompt injection; nothing from it reached the profile.
    expect(JSON.stringify(profile)).not.toContain('free forever')
    const icp = await db.row<{ provenance: Record<string, { editedByUser: boolean }> }>(
      'SELECT provenance FROM ideal_customer_profile WHERE "organizationId" = $1',
      [organizationId]
    )
    expect(icp?.provenance.pains?.editedByUser).toBe(true)

    // A re-run of the unchanged site reads no page and calls no model.
    await page.getByRole('button', { name: 'Read again' }).click()
    await expect
      .poll(async () => (await runs(organizationId)).map((row) => row.status), {
        timeout: RUN_TIMEOUT,
      })
      .toEqual(['completed', 'completed'])
    const rerun = (await runs(organizationId))[1]!
    expect(rerun.tokensUsed).toBe(0)
    expect(rerun.pagesSkipped).toBe(rerun.pagesDiscovered)

    await page.getByRole('button', { name: 'Looks right' }).click()
    await expect(page.getByText('Creating your first 7 posts')).toBeVisible()

    // After onboarding, a card in the corner of the app reports how far enrichment got.
    await app.open('/settings')
    const card = page.getByRole('complementary', { name: 'Profile enrichment' })
    await expect(card).toContainText('Your profile is enriched', { timeout: 30_000 })
    await expect(card.getByRole('progressbar', { name: 'Enrichment progress' })).toHaveAttribute(
      'aria-valuenow',
      '100'
    )
    await card.getByRole('button', { name: 'Dismiss' }).click()
    await expect(card).toBeHidden()
    await app.reload()
    await expect(page.getByRole('heading').first()).toBeVisible()
    await expect(card).toBeHidden()
  }
)

test(
  'runs stay in their workspace, and replays, bad input, and an unreadable site are handled',
  { tag: '@journey' },
  async ({ browser, identity, page }) => {
    const organizationId = await openProductStep(identity, page)
    const start = (url: string) =>
      browserRequest(page, '/api/v1/onboarding-runs', {
        body: JSON.stringify({ url }),
        headers: { 'content-type': 'application/json', 'idempotency-key': `e2e-${organizationId}` },
        method: 'POST',
      })

    const invalid = await start('ftp://screenshot-mock/acme')
    expect(invalid.status).toBe(400)
    // An unreadable site still completes: the run says why and the form stays.
    const created = await start(UNREADABLE)
    expect(created.status).toBe(201)
    const run = (created.body as { reason?: string; run: { id: string } }).run
    expect((created.body as { reason?: string }).reason).toMatch(/could not be reached/)
    const replay = await start(UNREADABLE)
    expect(replay.status).toBe(200)
    expect((replay.body as { created: boolean; run: { id: string } }).run.id).toBe(run.id)
    await expect
      .poll(async () => (await runs(organizationId)).map((row) => row.status))
      .toEqual(['completed'])

    const otherContext = await browser.newContext()
    const otherPage = await otherContext.newPage()
    try {
      await openProductStep(
        {
          ...identity,
          email: `other-${identity.email}`,
          workspaceName: `Other ${identity.workspaceName}`,
        },
        otherPage
      )
      for (const [path, method] of [
        [`/api/v1/onboarding-runs/${run.id}`, 'GET'],
        [`/api/v1/onboarding-runs/${run.id}/enrichment`, 'GET'],
        [`/api/v1/onboarding-runs/${run.id}/cancel`, 'POST'],
        [`/api/v1/onboarding-runs/${run.id}/rerun`, 'POST'],
      ] as const) {
        const response = await browserRequest(otherPage, path, { method })
        expect(response.status, `${method} ${path}`).toBe(404)
      }
      const otherProfile = await trpcQuery(otherPage, 'idealCustomerProfile.get')
      expect(otherProfile.body).toEqual({ idealCustomerProfile: null })
    } finally {
      await otherContext.close()
    }
    expect((await runs(organizationId)).length).toBe(1)

    // The manual form is always reachable.
    await page.getByRole('button', { name: 'Describe it yourself instead' }).click()
    await page.getByLabel('Product name').fill('Acme by hand')
    await page.getByLabel('Product URL').last().fill(`${MOCK}/acme`)
    await expect(page.getByRole('button', { name: 'Looks right' })).toBeEnabled()
  }
)

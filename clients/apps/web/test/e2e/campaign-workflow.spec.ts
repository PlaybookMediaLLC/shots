import {
  chooseOption,
  createWorkspace,
  type E2EIdentity,
  expect,
  getE2EUrl,
  test,
  trpcMutation,
  trpcQuery,
} from './framework'
import { z } from 'zod'

test.use({ workspaceOptions: { plan: 'pro' } })

const surfaceSchema = z.object({ productSurface: z.object({ id: z.string() }) })
const releaseSchema = z.object({ release: z.object({ id: z.string().uuid() }) })
const campaignSchema = z.object({
  campaign: z.object({
    id: z.string(),
    productSurface: z.object({ id: z.string() }).nullable(),
    release: z.object({ id: z.string(), title: z.string() }).nullable(),
    status: z.string(),
  }),
})
const campaignListSchema = z.object({ campaigns: z.array(z.object({ id: z.string() })) })

test(
  'a founder connects a product, describes a release, and returns to the same draft',
  { tag: '@smoke' },
  async ({ app, browser, identity, page }) => {
    await app.open('/campaigns')
    await page.getByRole('link', { name: 'New campaign' }).click()

    // A title and why it matters are enough; everything else is folded away.
    await page.getByRole('button', { name: 'More details', exact: true }).click()
    await chooseOption(page.getByLabel('Product', { exact: true }), 'Add a product…')
    await page.getByLabel('Product name').fill('Ledgerly')
    await page.getByLabel('App URL').fill('https://app.ledgerly.example')
    await chooseOption(page.getByLabel('Environment'), 'staging')
    await page.getByLabel('Marketing site URL (optional)').fill('https://ledgerly.example')
    await page.getByLabel('Release title').fill('Recurring invoices')
    await page.getByLabel('Why it matters').fill('Invoices now send themselves every month.')
    await page.getByLabel('Description').fill('Set a schedule once; Ledgerly sends the rest.')
    await page.getByLabel('Target audience').fill('Freelancers who bill monthly')
    await page.getByLabel('Source links (optional)').fill('https://ledgerly.example/changelog')
    await page.getByRole('button', { name: 'Create campaign' }).click()

    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/campaigns\/c[a-z0-9]{20,}$/)
    const campaignPath = new URL(page.url()).pathname
    const assertDraft = async (target = page) => {
      await expect(
        target.getByRole('heading', { level: 1, name: 'Recurring invoices' })
      ).toBeVisible()
      await expect(target.getByText('Draft', { exact: true })).toBeVisible()
      await expect(target.getByText('Invoices now send themselves every month.')).toBeVisible()
      await expect(target.getByText('Freelancers who bill monthly')).toBeVisible()
      await expect(target.getByText(/Ledgerly · staging ·/)).toBeVisible()
      await expect(
        target.getByRole('link', { name: 'https://ledgerly.example/changelog' })
      ).toBeVisible()
    }
    await assertDraft()

    await app.reload()
    await assertDraft()
    expect(new URL(page.url()).pathname).toBe(campaignPath)

    await page.getByRole('button', { name: 'Edit brief' }).click()
    await page.getByLabel('Description').fill('Schedules, reminders, and automatic retries.')
    await page.getByRole('button', { name: 'Save brief' }).click()
    await expect(page.getByText(/^Brief updated\./)).toBeVisible()
    await expect(page.getByText('Schedules, reminders, and automatic retries.')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(campaignPath)

    // A fresh sign-in finds the same campaign from the list.
    const returning = await browser.newContext()
    const returningPage = await returning.newPage()
    try {
      await returningPage.goto(getE2EUrl('/sign-in'))
      await returningPage.getByLabel('Email', { exact: true }).fill(identity.email)
      await returningPage.getByLabel('Password').fill(identity.password)
      await returningPage.getByRole('button', { name: 'Sign in' }).click()
      await expect.poll(() => new URL(returningPage.url()).pathname).toBe('/home')
      await returningPage.goto(getE2EUrl('/campaigns'))
      await returningPage.getByRole('link', { name: /Recurring invoices/ }).click()
      await expect.poll(() => new URL(returningPage.url()).pathname).toBe(campaignPath)
      await expect(
        returningPage.getByText('Schedules, reminders, and automatic retries.')
      ).toBeVisible()
    } finally {
      await returning.close()
    }
  }
)

test('campaign context stays inside its workspace and survives surface deletion', async ({
  browser,
  identity,
  page,
}) => {
  const surface = surfaceSchema.parse(
    (
      await trpcMutation(page, 'productSurface.create', {
        name: 'Web app',
        url: 'https://app.example.test',
      })
    ).body
  ).productSurface
  const release = releaseSchema.parse(
    (
      await trpcMutation(page, 'release.create', {
        benefitStatement: 'Private benefit.',
        productSurfaceId: surface.id,
        title: 'Private release',
      })
    ).body
  ).release
  const campaign = campaignSchema.parse(
    (
      await trpcMutation(page, 'campaign.create', {
        name: 'Private campaign',
        objective: 'Announce',
        releaseId: release.id,
      })
    ).body
  ).campaign
  // A campaign created from a release inherits its surface, and a draft may be empty.
  expect(campaign.status).toBe('DRAFT')
  expect(campaign.productSurface?.id).toBe(surface.id)

  // Five more drafts need no manual intervention.
  for (let index = 0; index < 5; index += 1) {
    const created = await trpcMutation(page, 'campaign.create', {
      name: `Draft ${index}`,
      objective: 'Announce',
    })
    expect(created.status).toBe(200)
  }
  const list = campaignListSchema.parse((await trpcQuery(page, 'campaign.list')).body)
  expect(list.campaigns).toHaveLength(6)

  // Empty drafts cannot enter review, and review cannot be skipped.
  const toReview = await trpcMutation(page, 'campaign.transition', {
    campaignId: campaign.id,
    status: 'READY_FOR_REVIEW',
  })
  expect(toReview.status).toBe(409)
  const skipReview = await trpcMutation(page, 'campaign.transition', {
    campaignId: campaign.id,
    status: 'APPROVED',
  })
  expect(skipReview.status).toBe(409)

  const other: E2EIdentity = {
    ...identity,
    email: `other-${identity.email}`,
    workspaceName: `Other ${identity.workspaceName}`,
  }
  const otherContext = await browser.newContext()
  const otherPage = await otherContext.newPage()
  try {
    await createWorkspace(other, otherPage)
    const foreign = [
      await trpcQuery(otherPage, 'campaign.get', { campaignId: campaign.id }),
      await trpcQuery(otherPage, 'release.get', { releaseId: release.id }),
      await trpcMutation(otherPage, 'release.update', { releaseId: release.id, title: 'Taken' }),
      await trpcMutation(otherPage, 'campaign.transition', {
        campaignId: campaign.id,
        status: 'ARCHIVED',
      }),
      await trpcMutation(otherPage, 'campaign.create', {
        name: 'Borrowed release',
        objective: 'Announce',
        releaseId: release.id,
      }),
      await trpcMutation(otherPage, 'campaign.create', {
        name: 'Borrowed surface',
        objective: 'Announce',
        productSurfaceId: surface.id,
      }),
      await trpcMutation(otherPage, 'release.create', {
        benefitStatement: 'Borrowed.',
        productSurfaceId: surface.id,
        title: 'Borrowed surface release',
      }),
    ]
    expect(foreign.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404, 404])
    const foreignPage = await otherPage.goto(getE2EUrl(`/campaigns/${campaign.id}`))
    expect(foreignPage?.status()).toBe(404)
  } finally {
    await otherContext.close()
  }

  const unchanged = campaignSchema.parse(
    (await trpcQuery(page, 'campaign.get', { campaignId: campaign.id })).body
  ).campaign
  expect(unchanged.status).toBe('DRAFT')
  expect(unchanged.release?.title).toBe('Private release')

  expect(
    (await trpcMutation(page, 'productSurface.delete', { surfaceId: surface.id })).status
  ).toBe(200)
  const afterDelete = campaignSchema.parse(
    (await trpcQuery(page, 'campaign.get', { campaignId: campaign.id })).body
  ).campaign
  expect(afterDelete.productSurface).toBeNull()
  expect(afterDelete.release?.id).toBe(release.id)

  const archived = await trpcMutation(page, 'campaign.transition', {
    campaignId: campaign.id,
    status: 'ARCHIVED',
  })
  expect(archived.status).toBe(200)
})

test(
  'a title and why it matters are enough for a campaign, with no product',
  { tag: '@journey' },
  async ({ app, page }) => {
    await app.open('/campaigns')
    await expect(page.getByRole('link', { name: 'New campaign' })).toHaveCount(1)
    await page.getByRole('link', { name: 'New campaign' }).click()
    await page.getByLabel('Release title').fill('Dark mode')
    await page.getByLabel('Why it matters').fill('Easier on the eyes at night.')
    await page.getByRole('button', { name: 'Create campaign' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Dark mode' })).toBeVisible()
  }
)

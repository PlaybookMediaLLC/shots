import { SETTINGS_SECTIONS } from '@/components/workspace/settings-sections'
import { db, expect, grantWorkspacePlan, openWorkspaceSetting, test } from './framework'

// There is no free plan: a workspace without a subscription can only choose
// one. Each test starts on Pro and drops the workspace to `free`, as a
// cancelled subscription leaves it, then checks the app says so instead of
// offering screens that fail with the API's raw refusal.
test.use({ workspaceOptions: { plan: 'pro' } })

test.describe('a workspace without a plan', () => {
  test.beforeEach(async ({ workspace }) => {
    await grantWorkspacePlan(workspace.id, 'free')
  })

  test('navigation marks what needs a plan and search runs no refused query', async ({
    app,
    page,
  }) => {
    const draftReads: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/v1/content-drafts'))
        draftReads.push(request.url())
    })
    await app.open('/upgrade')
    const navigation = page.getByRole('navigation', { exact: true, name: 'Workspace' })
    // Home and Publish check content drafts, like the areas already marked Pro.
    await expect(navigation.getByRole('link', { exact: true, name: 'Home (Pro)' })).toHaveAttribute(
      'href',
      '/upgrade?from=%2Fhome'
    )
    await expect(
      navigation.getByRole('link', { exact: true, name: 'Publish (Pro)' })
    ).toHaveAttribute('href', '/upgrade?from=%2Fpublish')

    // New → Post opens the plan page, not a composer that cannot save.
    await page.getByRole('button', { exact: true, name: 'New' }).click()
    await page.getByRole('menuitem', { exact: true, name: 'Post (Pro)' }).click()
    await app.expectPath('/upgrade')
    await expect(page.getByRole('heading', { level: 1, name: 'Publish is on Pro' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'New draft' })).toHaveCount(0)
    // Choosing a plan goes straight to the plan cards, not through Billing.
    await expect(page.getByRole('link', { exact: true, name: 'Choose a plan' })).toHaveAttribute(
      'href',
      '/pricing?returnTo=%2Fpublish'
    )

    await page.getByRole('button', { exact: true, name: 'Search and commands' }).first().click()
    const search = page.getByRole('dialog')
    await search.getByRole('searchbox', { name: 'Search destinations' }).fill('billing')
    // Billing lives in Settings; places stay searchable without a plan.
    await expect(search.getByRole('link', { name: /^Settings/ })).toBeVisible()
    await expect(search.getByText(/could not (be searched|load)/)).toHaveCount(0)
    expect(draftReads).toEqual([])
  })

  test('the screens the backend refuses explain the plan, with no endless loading', async ({
    page,
  }) => {
    for (const [section, notice, from] of [
      ['Shared links', 'Publishing designs at a link needs Pro.', 'shared-links'],
      ['Integrations', 'Delivering designs to Slack, Notion and Figma needs Pro.', 'integrations'],
      ['Profiles', 'Profiles, and the accounts and schedules', 'publishing-brands'],
      ['Notifications', 'Profiles, and notifications for each, need Pro.', 'notifications'],
      ['Developer API', 'Outbound webhooks need Pro.', 'developers'],
    ]) {
      await openWorkspaceSetting(page, section)
      const plan = page.getByRole('alert').filter({ hasText: notice })
      await expect(plan, section).toHaveCount(1)
      await expect(plan.getByRole('link', { exact: true, name: 'See plans' })).toHaveAttribute(
        'href',
        `/upgrade?from=%2Fsettings%2F${from}`
      )
      await expect(page.getByText('Loading…', { exact: true }), section).toHaveCount(0)
    }
    // Without a plan nothing in the catalog works, so nothing in it says Available.
    await openWorkspaceSetting(page, 'Integrations')
    await expect(
      page.getByLabel('Agents and integrations').getByText('Available', { exact: true })
    ).toHaveCount(0)
    // A webhook cannot be added without a plan, so the form is not offered.
    await openWorkspaceSetting(page, 'Developer API')
    await expect(page.getByRole('button', { exact: true, name: 'Add webhook' })).toHaveCount(0)
  })

  test('no settings section shows the raw refusal or loads forever', async ({ page }) => {
    // Beyond the audit's screens: every section a workspace without a plan can open.
    for (const { title } of SETTINGS_SECTIONS) {
      await openWorkspaceSetting(page, title)
      await expect(page.getByText(/^Loading/), title).toHaveCount(0)
      await expect(page.getByText(/capability is not available/), title).toHaveCount(0)
      await expect(page.getByRole('button', { name: /^(Retry|Try again)$/ }), title).toHaveCount(0)
    }
  })

  test('pricing keeps the way back to the workspace and reads its table aloud', async ({
    app,
    page,
  }) => {
    await app.open('/pricing')
    const header = page.getByRole('banner')
    await expect(header.getByRole('link', { exact: true, name: 'Open workspace' })).toBeVisible()
    await expect(header.getByRole('link', { exact: true, name: 'Sign in' })).toHaveCount(0)
    // The hero and closing banner stop asking a signed-in visitor to sign up.
    const content = page.getByRole('main')
    await expect(content.getByRole('link', { exact: true, name: 'Get started' })).toHaveCount(0)
    await expect(content.getByRole('link', { exact: true, name: 'Open workspace' })).toHaveCount(2)
    // Included cells say so to a screen reader, as excluded ones always did.
    const comparison = page.getByRole('table')
    await expect(comparison.getByRole('cell', { exact: true, name: 'Included' })).not.toHaveCount(0)
    await expect(
      comparison.getByRole('cell', { exact: true, name: 'Not included' })
    ).not.toHaveCount(0)
  })
})

// This one drops the plan itself, after the app has loaded on Pro.
test('a plan that lapses while the app is open: New post explains it instead of offering Retry', async ({
  app,
  page,
  workspace,
}) => {
  // The shell was drawn on Pro, so Post still opens the quick composer.
  await app.open('/home')
  await grantWorkspacePlan(workspace.id, 'free')
  await page.getByRole('button', { exact: true, name: 'New' }).click()
  await page.getByRole('menuitem', { exact: true, name: 'Post' }).click()
  const draft = page.getByRole('dialog', { name: 'New draft' })
  await expect(draft.getByText('Writing posts needs Pro.')).toBeVisible()
  await expect(draft.getByText(/capability is not available/)).toHaveCount(0)
  await expect(draft.getByRole('button', { exact: true, name: 'Retry' })).toHaveCount(0)
  // Following the plan link closes the box, which would otherwise cover the plan page.
  await draft.getByRole('link', { exact: true, name: 'See plans' }).click()
  await app.expectPath('/upgrade')
  await expect(page.getByRole('dialog', { name: 'New draft' })).toHaveCount(0)
  expect(
    await db.row('SELECT count(*)::int AS drafts FROM content_draft WHERE "organizationId" = $1', [
      workspace.id,
    ])
  ).toEqual({ drafts: 0 })
})

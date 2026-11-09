import { randomBytes } from 'node:crypto'
import { samplePlan, sampleSpec } from '../launch-fixtures'
import { db, expect, test, trpcMutation, type Page } from './framework'

test.use({ workspaceOptions: { plan: 'pro' } })

async function launchDraft(page: Page, organizationId: string) {
  const release = await trpcMutation(page, 'release.create', {
    title: 'Editing regression',
    benefitStatement: 'Bill clients without chasing invoices.',
  })
  expect(release.status).toBe(200)
  const releaseId = (release.body as { release: { id: string } }).release.id
  const campaign = await trpcMutation(page, 'campaign.create', {
    name: 'Editing regression',
    objective: 'Launch',
    releaseId,
  })
  expect(campaign.status).toBe(200)
  const campaignId = (campaign.body as { campaign: { id: string } }).campaign.id
  const specId = `c${randomBytes(12).toString('hex')}`
  // Fixture content cites the real brief, so subsequent edits undergo normal reference validation.
  const content = JSON.parse(JSON.stringify(sampleSpec()), (key, value: unknown) =>
    key === 'sources' ? ['brief'] : value
  )
  await db.query(
    `INSERT INTO release_spec (id, "organizationId", "releaseId", version, origin, content)
    VALUES ($1, $2, $3, 1, 'human', $4)`,
    [specId, organizationId, releaseId, content]
  )
  return { campaignId, releaseId, specId }
}

test('spec answers and sections cannot be discarded by approval, another editor, or navigation', async ({
  app,
  page,
  workspace,
}) => {
  const { campaignId, releaseId, specId } = await launchDraft(page, workspace.id)
  await app.open(`/campaigns/${campaignId}/spec`)
  const answer = page.getByLabel('Answer: Is there a usage limit?')
  await answer.fill('Up to 100 schedules')
  await expect(page.getByRole('button', { name: 'Approve spec', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Edit Summary', exact: true })).toBeDisabled()
  expect(await db.row('SELECT status FROM release_spec WHERE id = $1', [specId])).toEqual({
    status: 'DRAFT',
  })
  await page.getByRole('button', { name: 'Save answers', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Version' })).toContainText('v2')
  await expect(answer).toHaveValue('Up to 100 schedules')
  await page.getByRole('button', { name: 'Edit Summary', exact: true }).click()
  const summary = page.locator('#spec-summary').getByRole('textbox')
  await summary.fill('A revised summary [brief]')
  await expect(answer).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Approve spec', exact: true })).toBeDisabled()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('combobox', { name: 'Version' }).click()
  await page.getByRole('option', { name: /^v1 / }).click()
  await expect(summary).toHaveValue('A revised summary [brief]')
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('link', { name: 'Plan', exact: true }).click()
  await expect(summary).toHaveValue('A revised summary [brief]')
  await page
    .locator('#spec-summary')
    .getByRole('button', { name: 'Save section', exact: true })
    .click()
  await expect(page.getByRole('combobox', { name: 'Version' })).toContainText('v3')
  const saved = await db.row<{ content: ReturnType<typeof sampleSpec>; id: string }>(
    'SELECT id, content FROM release_spec WHERE "releaseId" = $1 AND version = 3',
    [releaseId]
  )
  expect(saved?.content.summary.text).toBe('A revised summary')
  expect(saved?.content.openQuestions[0].answer).toBe('Up to 100 schedules')
  await page.getByRole('button', { name: 'Approve spec', exact: true }).click()
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
  expect(await db.row('SELECT status FROM release_spec WHERE id = $1', [saved!.id])).toEqual({
    status: 'APPROVED',
  })
  await page.getByRole('button', { name: 'Edit Summary', exact: true }).click()
  await summary.fill('Discard this version draft [brief]')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('combobox', { name: 'Version' }).click()
  await page.getByRole('option', { name: /^v1 / }).click()
  await expect(
    page.getByText('You are viewing v1, an earlier version. It is read-only.')
  ).toBeVisible()
  await expect(summary).toHaveCount(0)
  await page.getByRole('link', { name: 'View the latest', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Version' })).toContainText('v3')
  await expect(page.getByText('Discard this version draft')).toHaveCount(0)
})

test('plan drafts block approval and navigation and freeze during a delayed real save', async ({
  app,
  page,
  workspace,
}) => {
  const { campaignId, specId } = await launchDraft(page, workspace.id)
  await db.query(
    `UPDATE release_spec SET status = 'APPROVED', "approvedAt" = now() WHERE id = $1`,
    [specId]
  )
  const planId = `c${randomBytes(12).toString('hex')}`
  await db.query(
    `INSERT INTO campaign_plan (id, "organizationId", "campaignId", "specId", version, origin, content)
    VALUES ($1, $2, $3, $4, 1, 'human', $5)`,
    [planId, workspace.id, campaignId, specId, samplePlan()]
  )
  await app.open(`/campaigns/${campaignId}/plan`)
  await page.getByRole('button', { name: /Edit plan as JSON/ }).click()
  const editor = page.getByLabel('Plan JSON', { exact: true })
  const content = { ...samplePlan(), summary: 'The saved edited summary.' }
  await editor.fill(JSON.stringify(content, null, 2))
  await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('link', { name: 'Brief & evidence', exact: true }).click()
  await expect(editor).toHaveValue(JSON.stringify(content, null, 2))
  let releaseSave!: () => void
  const released = new Promise<void>((resolve) => {
    releaseSave = resolve
  })
  await page.route('**/api/trpc/launch.plan.update*', async (route) => {
    await released
    await route.continue()
  })
  try {
    await page.getByRole('button', { name: 'Save plan', exact: true }).click()
    await expect(editor).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Approve plan', exact: true })).toBeDisabled()
  } finally {
    releaseSave()
  }
  await expect(page.getByRole('combobox', { name: 'Version' })).toContainText('v2')
  const saved = await db.row<{ id: string; content: ReturnType<typeof samplePlan> }>(
    'SELECT id, content FROM campaign_plan WHERE "campaignId" = $1 AND version = 2',
    [campaignId]
  )
  expect(saved?.content).toEqual(content)
  await page.getByRole('button', { name: 'Approve plan', exact: true }).click()
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible()
  expect(await db.row('SELECT status FROM campaign_plan WHERE id = $1', [saved!.id])).toEqual({
    status: 'APPROVED',
  })
})

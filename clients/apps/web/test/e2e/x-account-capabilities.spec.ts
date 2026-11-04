import { z } from 'zod'
import { contentDraftSchema } from '../../lib/api/contracts/content-drafts'
import { apiRequest, db, draftEditor, expect, expectSaved, openNewDraft, test } from './framework'

const draftReceiptSchema = contentDraftSchema.pick({ id: true, version: true, plainText: true })

test('X composer reads verified limits and keeps Basic Articles unavailable', async ({
  app,
  page,
  startWorkspace,
}) => {
  const workspace = await startWorkspace({ channels: ['x'] })
  const integrationId = `social-${workspace.id}-x`
  // Editable historical metadata cannot grant a long-post allowance.
  await db.query(`UPDATE "Integration" SET "additionalSettings"=$2 WHERE id=$1`, [
    integrationId,
    JSON.stringify([{ title: 'Verified', value: true }]),
  ])
  const id = await openNewDraft(page)
  await draftEditor(page).fill('a'.repeat(281))
  await expectSaved(page)
  await expect(page.getByTestId('post-length-1')).toHaveText('281 / 280')

  // Simulate the authenticated provider's Basic proof, not a UI billing switch.
  await db.query(
    `UPDATE "Integration" SET "verifiedCapabilities" = jsonb_set(
      "verifiedCapabilities"::jsonb, '{x}', "verifiedCapabilities"::jsonb->'x' || $2::jsonb)
      WHERE id=$1`,
    [
      integrationId,
      JSON.stringify({
        subscriptionType: 'Basic',
        longPostMaxWeightedCharacters: 25000,
        articles: false,
      }),
    ]
  )
  await app.reload()
  await expect(page.getByTestId('post-length-1')).toHaveText('281 / 25000')
  await expect(draftEditor(page).getByText('a'.repeat(281), { exact: true })).toBeVisible()
  const saved = await apiRequest(page, `/api/v1/content-drafts/${id}`)
  expect(saved.status).toBe(200)
  expect(draftReceiptSchema.parse(saved.body).plainText).toBe('a'.repeat(281))
  await page.getByRole('button', { name: 'Manage platforms', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('longer posts verified')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.screenshot({
    path: '.context/x-content-basic-long-post.png',
    animations: 'disabled',
  })

  const created = await apiRequest(page, '/api/v1/content-drafts', {
    method: 'POST',
    body: {
      kind: 'article',
      article: { title: 'Basic account article' },
      body: [{ type: 'p', children: [{ text: 'An article needs separate access.' }] }],
    },
  })
  expect(created.status).toBe(201)
  const article = draftReceiptSchema.parse(created.body)
  await app.open(`/publish/${article.id}`)
  await expect(draftEditor(page)).toBeVisible()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.getByTestId('preview-panel')).toContainText('Connect an eligible account.')
  await page.screenshot({ path: '.context/x-content-basic-article.png', animations: 'disabled' })
  const denied = await apiRequest(page, `/api/v1/content-drafts/${article.id}/schedule`, {
    method: 'POST',
    body: {
      channelConnectionIds: [workspace.channels.x],
      version: article.version,
      scheduledFor: new Date(Date.now() + 86400000).toISOString(),
    },
  })
  expect(denied.status).toBe(409)
  const scheduled = await db.query(
    'SELECT id FROM scheduled_post WHERE "contentDraftId" IN ($1,$2)',
    [id, article.id]
  )
  expect(z.array(z.object({ id: z.string() })).parse(scheduled.rows)).toHaveLength(0)
})

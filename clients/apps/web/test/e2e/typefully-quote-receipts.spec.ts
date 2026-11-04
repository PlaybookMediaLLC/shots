import { apiRequest, db, expect, test } from './framework'
import { importedBody } from '@/lib/write/import-text'

test('pending and rejected native quote receipts remain published and never offer a duplicate retry', async ({
  app,
  page,
  startWorkspace,
}) => {
  const workspace = await startWorkspace({ channels: ['x'] })
  const created = await apiRequest(page, '/api/v1/content-drafts', {
    method: 'POST',
    body: {
      body: importedBody(['Confirmed quote']),
      plainText: 'Confirmed quote',
      channelConnectionIds: [workspace.channels.x],
    },
  })
  expect(created.status).toBe(201)
  const draft = created.body as { id: string; version: number }
  const queued = await apiRequest(page, `/api/v1/content-drafts/${draft.id}/schedule`, {
    method: 'POST',
    body: {
      version: draft.version,
      scheduledFor: new Date(Date.now() + 86400000).toISOString(),
      channelConnectionIds: [workspace.channels.x],
    },
  })
  expect(queued.status).toBe(201)
  // This verifies the stored receipt projection, not live Mastodon federation.
  const quotes = [
    { postId: 'root', state: 'pending' },
    { postId: 'reply', state: 'rejected' },
    { postId: 'last', state: 'unconfirmed' },
  ]
  await db.query(
    `UPDATE scheduled_post SET status='PUBLISHED',"remotePostId"='root',"publishedAt"=now(),"threadProgress"=$2 WHERE "contentDraftId"=$1`,
    [draft.id, JSON.stringify({ posted: 0, total: 0, quotes })]
  )
  await app.open(`/publish/${draft.id}`)
  const post = page.getByTestId('draft-post')
  for (const quote of quotes)
    await expect(post).toContainText(
      `Native quote on post ${quote.postId}: ${quote.state} when published.`
    )
  await expect(post).toContainText('Do not republish it to retry approval')
  await expect(post.getByRole('button', { name: 'Retry this destination' })).toHaveCount(0)
  await expect(post.getByRole('button', { name: 'Post the rest' })).toHaveCount(0)
  await app.reload()
  await expect(post).toContainText('unconfirmed when published')
  expect(
    (
      await db.query(`SELECT count(*)::int AS n FROM scheduled_post WHERE "contentDraftId"=$1`, [
        draft.id,
      ])
    ).rows[0].n
  ).toBe(1)
})

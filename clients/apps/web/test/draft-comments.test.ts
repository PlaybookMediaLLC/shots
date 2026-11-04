import assert from 'node:assert/strict'
import test from 'node:test'
import { draftCommentInputSchema } from '../../../packages/screenshot-studio-backend-sdk/src/draft-comments'

const add = { action: 'add', baseVersion: 1, commentId: 'comment-1', text: 'Please review.' }

test('comment commands reject content edits, forged authors, timestamps and invalid action fields', () => {
  assert.deepEqual(draftCommentInputSchema.parse(add), add)
  for (const extra of [
    { body: [] },
    { userId: 'someone' },
    { createdAt: '2026-10-21' },
    { resolved: true },
  ]) {
    assert.equal(draftCommentInputSchema.safeParse({ ...add, ...extra }).success, false)
  }
  for (const input of [
    { ...add, baseVersion: 0 },
    { ...add, text: '  ' },
    { ...add, text: 'x'.repeat(5001) },
    { action: 'edit', baseVersion: 1, commentId: 'a', text: 'Missing thread' },
    { action: 'resolve', baseVersion: 1, threadId: 't' },
    { action: 'delete', baseVersion: 1, threadId: 't', commentId: 'a', text: 'Unexpected text' },
  ]) {
    assert.equal(draftCommentInputSchema.safeParse(input).success, false)
  }
})

test('comment commands keep explicit mention identities and thread targets', () => {
  const reply = { ...add, threadId: 'thread-1', mentionUserIds: ['user-1'] }
  assert.deepEqual(draftCommentInputSchema.parse(reply), reply)
  assert.deepEqual(
    draftCommentInputSchema.parse({
      action: 'resolve',
      baseVersion: 2,
      threadId: 'thread-1',
      resolved: false,
    }),
    { action: 'resolve', baseVersion: 2, threadId: 'thread-1', resolved: false }
  )
})

test('post and text anchors remain on their original post after content changes', async () => {
  const { commentAnchorExists } = await import('../lib/write/comment-anchors')
  const { importedBody } = await import('../lib/write/import-text')
  const body = importedBody(['Evidence here', 'Evidence elsewhere'])
  const versions = { schemaVersion: 1 as const, versions: [] }
  const postId = body[0].id
  const anchor = { scope: 'text', platform: 'x', postId, documentContent: 'Evidence here' }
  assert.equal(commentAnchorExists(anchor, body, versions, 'x'), true)
  assert.equal(commentAnchorExists({ ...anchor, postId: 'deleted' }, body, versions, 'x'), false)
  assert.equal(
    commentAnchorExists({ ...anchor, documentContent: 'Evidence elsewhere' }, body, versions, 'x'),
    false
  )
  assert.equal(commentAnchorExists({ ...anchor, scope: 'post' }, body, versions, 'x'), true)
  assert.equal(commentAnchorExists({ ...anchor, platform: 'linkedin' }, body, versions, 'x'), false)
})

test('anchored additions extend the original comment protocol without overlapping alternatives', () => {
  const anchor = { platform: 'x', postId: 'post-1', quote: 'Evidence' }
  for (const platform of ['x', 'tiktok', 'youtube']) {
    const input = { ...add, anchor: { ...anchor, platform } }
    assert.deepEqual(draftCommentInputSchema.parse(input), input)
  }
  for (const action of [
    add,
    {
      action: 'edit',
      baseVersion: 2,
      threadId: 'thread-1',
      commentId: 'comment-1',
      text: 'Updated',
    },
    { action: 'delete', baseVersion: 2, threadId: 'thread-1', commentId: 'comment-1' },
    { action: 'resolve', baseVersion: 2, threadId: 'thread-1', resolved: true },
    { action: 'delete_thread', baseVersion: 2, threadId: 'thread-1' },
  ])
    assert.deepEqual(draftCommentInputSchema.parse(action), action)
  for (const invalid of [
    { ...anchor, platform: 'unknown' },
    { ...anchor, postId: '' },
    { ...anchor, userId: 'forged' },
  ])
    assert.equal(draftCommentInputSchema.safeParse({ ...add, anchor: invalid }).success, false)
})

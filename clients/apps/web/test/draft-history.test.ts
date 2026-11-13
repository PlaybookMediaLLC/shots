import assert from 'node:assert/strict'
import test from 'node:test'
import type { DraftActivityWire } from '@/lib/write/client'
import { actionLabel, groupHistory, HISTORY_GROUP_GAP_MS } from '@/lib/write/history'

const start = Date.parse('2026-11-13T12:00:00Z')

/** An event `minutesAgo` before start, by a person or, with no person, a source. */
function event(
  id: string,
  minutesAgo: number,
  by: { person?: string; source?: DraftActivityWire['source'] }
): DraftActivityWire {
  return {
    action: 'product.content_draft_updated',
    actorName: by.person ?? null,
    actorType: by.person ? 'USER' : 'SERVICE',
    actorUserId: by.person ?? null,
    at: new Date(start - minutesAgo * 60_000).toISOString(),
    entityId: 'draft',
    id,
    metadata: {},
    source: by.source ?? 'person',
  }
}

test('consecutive changes by one author within the gap are one entry, in order', () => {
  const gap = HISTORY_GROUP_GAP_MS / 60_000
  const history = [
    event('a', 0, { person: 'ana' }),
    event('b', 10, { person: 'ana' }),
    // Within the gap of the group's oldest change, not of its newest.
    event('c', 10 + gap, { person: 'ana' }),
    // One minute past the gap starts a new entry.
    event('d', 11 + 2 * gap, { person: 'ana' }),
    event('e', 12 + 2 * gap, { person: 'ben' }),
    event('f', 13 + 2 * gap, { source: 'api' }),
    event('g', 14 + 2 * gap, { source: 'mcp' }),
    event('h', 15 + 2 * gap, { source: 'mcp' }),
    event('i', 16 + 2 * gap, { person: 'ben' }),
  ]
  const groups = groupHistory(history).map((group) => group.items.map((item) => item.id).join(''))
  assert.deepEqual(groups, ['abc', 'd', 'e', 'f', 'gh', 'i'])
  assert.deepEqual(groupHistory([]), [])
})

test('comment, post and draft actions read as sentences, and a reopen is not a resolve', () => {
  const as = (action: string, metadata: Record<string, unknown> = {}) =>
    actionLabel({ ...event('x', 0, { person: 'ana' }), action, metadata })
  assert.equal(
    as('product.content_draft_comment_resolve', { resolved: true }),
    'Resolved a discussion'
  )
  assert.equal(
    as('product.content_draft_comment_resolve', { resolved: false }),
    'Reopened a discussion'
  )
  assert.equal(as('product.content_draft_comment_add'), 'Commented')
  assert.equal(as('post.publish_now'), 'Queued a post to publish now')
  // An action without a sentence still reads as words.
  assert.equal(as('product.content_draft_unknown_step'), 'content draft unknown step')
})

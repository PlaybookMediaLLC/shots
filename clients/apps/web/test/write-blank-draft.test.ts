import assert from 'node:assert/strict'
import test from 'node:test'
import { blankDraftContext } from '@/lib/write/composing-session'

const account = (id: string, channel: 'x' | 'threads' | 'tiktok' | 'linkedin') => ({
  channel,
  displayName: null,
  handle: `founder_${channel}`,
  id,
})
const set = {
  accounts: [
    account('tiktok1', 'tiktok'),
    account('x1', 'x'),
    account('threads1', 'threads'),
    account('linkedin1', 'linkedin'),
  ],
  defaultPlatforms: ['tiktok', 'x', 'threads', 'linkedin'],
  id: 'set1',
  primaryPlatform: 'tiktok',
}

test('an X-only draft starts the next one on X, not the brand’s TikTok', () => {
  const next = blankDraftContext(set, { channelIds: ['x1'], primary: 'x' })
  assert.deepEqual(next.channelConnectionIds, ['x1'])
  assert.deepEqual(
    next.accounts.map((item) => item.id),
    ['x1']
  )
  assert.equal(next.primaryPlatform, 'x')
})

test('chosen accounts without TikTok never open on TikTok', () => {
  const next = blankDraftContext(set, { channelIds: ['x1', 'threads1'] })
  assert.equal(next.primaryPlatform, 'x')
  const noX = blankDraftContext(set, { channelIds: ['linkedin1', 'threads1'] })
  assert.equal(noX.primaryPlatform, 'linkedin')
})

test('the open draft’s main platform stays while it publishes there', () => {
  assert.equal(
    blankDraftContext(set, { channelIds: ['x1', 'threads1'], primary: 'threads' }).primaryPlatform,
    'threads'
  )
})

test('with no main platform, chosen accounts open on X and defaults on their first', () => {
  const unset = { ...set, primaryPlatform: null }
  assert.equal(blankDraftContext(unset, { channelIds: ['linkedin1', 'x1'] }).primaryPlatform, 'x')
  assert.equal(blankDraftContext(unset).primaryPlatform, 'tiktok')
})

test('every account switched off falls back to the brand’s defaults', () => {
  assert.equal(blankDraftContext(set, { channelIds: [] }).channelConnectionIds, undefined)
})

test('with nothing chosen the brand’s defaults and main platform apply', () => {
  const next = blankDraftContext(set)
  assert.equal(next.channelConnectionIds, undefined)
  assert.deepEqual(
    next.accounts.map((item) => item.id),
    ['tiktok1', 'x1', 'threads1', 'linkedin1']
  )
  assert.equal(next.primaryPlatform, 'tiktok')
})

test('no brand writes for X with nothing to show', () => {
  assert.deepEqual(blankDraftContext(null), {
    accounts: [],
    channelConnectionIds: undefined,
    primaryPlatform: 'x',
  })
})

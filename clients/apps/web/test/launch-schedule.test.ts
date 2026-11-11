import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRunStale } from '../lib/launch/run-lease'
import { connectionsForChannel, customScheduleTime, visualChoices } from '../lib/launch/schedule'
import type { CampaignPlanContent } from '../lib/launch/spec-schema'

const connections = [
  { id: 'x1', platform: 'x', status: 'ACTIVE' },
  { id: 'x2', platform: 'x', status: 'REVOKED' },
  { id: 'li', platform: 'linkedin', status: 'ACTIVE' },
  { id: 'ig', platform: 'instagram', status: 'ACTIVE' },
  { id: 'igs', platform: 'instagram-standalone', status: 'ACTIVE' },
]

test('custom scheduling accepts only empty or complete, unambiguous choices in the displayed zone', () => {
  assert.equal(customScheduleTime('', '', 'America/New_York'), undefined)
  assert.throws(() => customScheduleTime('2026-11-10', '', 'America/New_York'), /both/)
  assert.throws(() => customScheduleTime('', '09:00', 'America/New_York'), /both/)
  assert.equal(
    customScheduleTime('2026-11-10', '09:00', 'America/New_York'),
    '2026-11-10T14:00:00.000Z'
  )
  assert.equal(
    customScheduleTime('2026-11-10', '09:00', 'Europe/London'),
    '2026-11-10T09:00:00.000Z'
  )
  assert.throws(
    () => customScheduleTime('2027-03-14', '02:30', 'America/New_York'),
    /does not exist/
  )
  assert.throws(() => customScheduleTime('2027-11-07', '01:30', 'America/New_York'), /twice/)
})

test('a post channel offers only active connections on its platforms', () => {
  assert.deepEqual(
    connectionsForChannel('x', connections)?.map((entry) => entry.id),
    ['x1']
  )
  assert.deepEqual(
    connectionsForChannel('linkedin', connections)?.map((entry) => entry.id),
    ['li']
  )
  assert.deepEqual(
    connectionsForChannel('instagram', connections)?.map((entry) => entry.id),
    ['ig', 'igs']
  )
})

test('channels without a publishing platform cannot be scheduled', () => {
  assert.equal(connectionsForChannel('email', connections), null)
  assert.equal(connectionsForChannel('product_hunt', []), null)
  assert.deepEqual(connectionsForChannel('x', []), [])
})

const plan: Pick<CampaignPlanContent, 'timeline'> = {
  timeline: [
    { angleKey: 'G1', assetKeys: ['A1'], channel: 'x', day: 0, note: '', phase: 'launch' },
    { angleKey: 'G1', assetKeys: ['A2'], channel: 'x', day: -2, note: '', phase: 'teaser' },
    { angleKey: 'G2', assetKeys: ['A3'], channel: 'linkedin', day: 0, note: '', phase: 'launch' },
  ],
}
const approved = [
  { id: 'v1', planAssetKey: 'A1' },
  { id: 'v2', planAssetKey: 'A2' },
  { id: 'v3', planAssetKey: 'A3' },
  { id: 'v4', planAssetKey: null },
]

test('the visual picker offers the visuals the timeline pairs with the post', () => {
  const ids = (post: { channel: string; phase: string | null; planItemKey: string | null }) =>
    visualChoices(post, plan, approved).map((visual) => visual.id)
  assert.deepEqual(ids({ channel: 'x', phase: 'launch', planItemKey: 'G1' }), ['v1'])
  assert.deepEqual(ids({ channel: 'x', phase: null, planItemKey: 'G1' }), ['v1', 'v2'])
  assert.deepEqual(ids({ channel: 'linkedin', phase: 'launch', planItemKey: 'G2' }), ['v3'])
})

test('the visual picker falls back to every approved visual', () => {
  const all = ['v1', 'v2', 'v3', 'v4']
  const ids = (post: { channel: string; phase: string | null; planItemKey: string | null }) =>
    visualChoices(post, plan, approved).map((visual) => visual.id)
  assert.deepEqual(ids({ channel: 'instagram', phase: 'launch', planItemKey: 'G1' }), all)
  assert.deepEqual(ids({ channel: 'x', phase: 'launch', planItemKey: null }), all)
  assert.deepEqual(
    visualChoices({ channel: 'x', phase: 'launch', planItemKey: 'G1' }, null, approved).length,
    4
  )
})

test('a run with heartbeats is stale after two minutes of silence', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  const startedAt = new Date(now - 60 * 60_000)
  assert.equal(isRunStale({ heartbeatAt: new Date(now - 90_000), startedAt }, now), false)
  assert.equal(isRunStale({ heartbeatAt: new Date(now - 3 * 60_000), startedAt }, now), true)
})

test('a run without heartbeats keeps the twenty-minute window', () => {
  const now = Date.parse('2026-10-16T12:00:00Z')
  assert.equal(
    isRunStale({ heartbeatAt: null, startedAt: new Date(now - 10 * 60_000) }, now),
    false
  )
  assert.equal(isRunStale({ heartbeatAt: null, startedAt: new Date(now - 21 * 60_000) }, now), true)
})

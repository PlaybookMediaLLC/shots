import assert from 'node:assert/strict'
import test from 'node:test'
import {
  committedMessage,
  isTimeZone,
  offsetLabel,
  readWhen,
  resolveLocalTime,
  wallTime,
} from '@/lib/write/zoned-time'

test('an ordinary local time names one instant', () => {
  const result = resolveLocalTime('2026-07-01T12:00', 'Europe/Paris')
  assert.equal(result.kind, 'exact')
  if (result.kind === 'exact') assert.equal(result.at.toISOString(), '2026-07-01T10:00:00.000Z')
  const tokyo = resolveLocalTime('2026-01-15T09:30', 'Asia/Tokyo')
  assert.ok(tokyo.kind === 'exact' && tokyo.at.toISOString() === '2026-01-15T00:30:00.000Z')
})

test('a time the clocks skip names no instant', () => {
  // US clocks go from 01:59 to 03:00 on 8 March 2026.
  assert.deepEqual(resolveLocalTime('2026-03-08T02:30', 'America/New_York'), { kind: 'gap' })
  // Europe goes from 01:59 UTC (02:59 CET) to 04:00 CEST on 29 March 2026.
  assert.deepEqual(resolveLocalTime('2026-03-29T02:15', 'Europe/Paris'), { kind: 'gap' })
})

test('a time the clocks repeat names two instants, an hour apart', () => {
  const result = resolveLocalTime('2026-11-01T01:30', 'America/New_York')
  assert.equal(result.kind, 'ambiguous')
  if (result.kind === 'ambiguous') {
    assert.equal(result.earlier.toISOString(), '2026-11-01T05:30:00.000Z')
    assert.equal(result.later.toISOString(), '2026-11-01T06:30:00.000Z')
  }
})

test('half-hour zones and UTC resolve exactly', () => {
  const india = resolveLocalTime('2026-05-05T08:00', 'Asia/Kolkata')
  assert.ok(india.kind === 'exact' && india.at.toISOString() === '2026-05-05T02:30:00.000Z')
  const utc = resolveLocalTime('2026-05-05T08:00', 'UTC')
  assert.ok(utc.kind === 'exact' && utc.at.toISOString() === '2026-05-05T08:00:00.000Z')
  assert.equal(offsetLabel(new Date('2026-05-05T08:00:00Z'), 'Asia/Kolkata'), 'UTC+05:30')
  assert.equal(offsetLabel(new Date('2026-01-05T08:00:00Z'), 'America/New_York'), 'UTC−05:00')
})

test('wall time round-trips and zones are checked', () => {
  assert.equal(wallTime(new Date('2026-07-01T10:00:00Z'), 'Europe/Paris'), '2026-07-01T12:00')
  assert.equal(isTimeZone('Europe/Paris'), true)
  assert.equal(isTimeZone('Mars/Olympus'), false)
  assert.throws(() => resolveLocalTime('tomorrow', 'UTC'))
})

test('typed times are read in the set’s zone, not the browser’s', () => {
  // 2026-10-20 18:10 UTC is 14:10 in New York and 03:10 the next day in Tokyo.
  const now = new Date('2026-10-20T18:10:00Z')
  assert.equal(readWhen('tomorrow 9am', 'UTC', now), '2026-10-21T09:00')
  assert.equal(readWhen('tomorrow 9am', 'Asia/Tokyo', now), '2026-10-22T09:00')
  assert.equal(readWhen('in 3 hours', 'America/New_York', now), '2026-10-20T17:15')
  assert.equal(readWhen('not a time', 'UTC', now), null)
})

test('a confirmed schedule names the stored instant, its zone and offset, and a moved queue slot', () => {
  const explicit = committedMessage(
    [
      { scheduledFor: '2026-11-04T15:00:00.000Z', slotAt: null },
      { scheduledFor: '2026-11-04T15:00:00.000Z' },
    ],
    'America/New_York',
    false
  )
  assert.match(explicit, /^Scheduled 2 posts for .*10:00.* · America\/New_York \(UTC−05:00\)\.$/)
  assert.doesNotMatch(explicit, /slot/)
  // A natural offset moves the instant off the 9:00 slot; both are disclosed.
  const queued = committedMessage(
    [{ scheduledFor: '2026-11-04T14:02:37.000Z', slotAt: '2026-11-04T14:00:00.000Z' }],
    'America/New_York',
    true
  )
  assert.match(
    queued,
    /^Added 1 post to the queue in the .*9:00.* slot, publishing .*9:02:37.*\(UTC−05:00\)\.$/
  )
})

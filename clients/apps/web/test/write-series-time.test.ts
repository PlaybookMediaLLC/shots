import assert from 'node:assert/strict'
import test from 'node:test'
import { nextSeriesTime, SERIES_WINDOW_MS } from '@/lib/write/series-time'

const now = new Date('2026-11-06T18:00:00.000Z')
const iso = (offsetMinutes: number) =>
  new Date(now.getTime() + offsetMinutes * 60_000).toISOString()

test('a run of posts opens a gap after the latest one already queued', () => {
  assert.equal(
    nextSeriesTime({
      gapMinutes: 60,
      now,
      queued: [iso(30), iso(120), iso(90)],
      slots: [],
    })?.toISOString(),
    iso(180)
  )
})

test('a learned gap is used instead of an hour', () => {
  assert.equal(
    nextSeriesTime({ gapMinutes: 20, now, queued: [iso(45)], slots: [] })?.toISOString(),
    iso(65)
  )
})

test('posts in the past or beyond a day do not set the next time', () => {
  const far = new Date(now.getTime() + SERIES_WINDOW_MS + 60_000).toISOString()
  assert.equal(nextSeriesTime({ gapMinutes: 60, now, queued: [iso(-120), far], slots: [] }), null)
})

test('with nothing queued nearby, the next free recurring slot wins', () => {
  const soon = new Date(now.getTime() + 5 * 3_600_000)
  const later = new Date(now.getTime() + 9 * 3_600_000)
  assert.equal(
    nextSeriesTime({
      gapMinutes: 60,
      now,
      queued: [],
      slots: [later, soon, new Date(now.getTime() - 3_600_000)],
    })?.toISOString(),
    soon.toISOString()
  )
})

test('nothing queued and no free slot leaves the caller its own default', () => {
  assert.equal(nextSeriesTime({ gapMinutes: 60, now, queued: [], slots: [] }), null)
})

test('an unreadable queued time is ignored rather than throwing', () => {
  assert.equal(
    nextSeriesTime({
      gapMinutes: 60,
      now,
      queued: ['not a time', iso(10)],
      slots: [],
    })?.toISOString(),
    iso(70)
  )
})

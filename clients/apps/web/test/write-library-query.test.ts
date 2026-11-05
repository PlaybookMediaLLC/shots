import assert from 'node:assert/strict'
import test from 'node:test'
import { datePreset, filterQueue, libraryQuery, libraryRange } from '@/lib/write/library'

test('FILTER-01: a search typed while a filter removal is in flight does not restore the filter', () => {
  let location = '?set=brand&kind=article'
  const query = libraryQuery(() => location)
  assert.deepEqual(query.change({ kind: undefined }), { navigate: true, search: 'set=brand' })
  // The address bar still shows the removed filter until the router commits.
  assert.deepEqual(query.change({ q: 'QA keyboard' }), {
    navigate: true,
    search: 'set=brand&q=QA+keyboard',
  })
  query.settle()
  location = '?set=brand&q=QA+keyboard'
  // Settled, a search alone filters the loaded drafts without a navigation.
  assert.deepEqual(query.change({ q: 'QA' }), { navigate: false, search: 'set=brand&q=QA' })
  // Back/forward commits another URL; the next change starts from it.
  query.settle()
  location = '?set=brand&kind=thread'
  assert.deepEqual(query.change({ q: undefined, tag: undefined, kind: undefined }), {
    navigate: true,
    search: 'set=brand',
  })
})

test('a lifecycle tab alone switches without a navigation', () => {
  const query = libraryQuery(() => '?set=brand')
  assert.deepEqual(query.change({ tab: 'queue' }), {
    navigate: false,
    search: 'set=brand&tab=queue',
  })
  assert.deepEqual(query.change({ kind: 'thread' }), {
    navigate: true,
    search: 'set=brand&kind=thread',
  })
})

test('filter days become instants in the brand zone, and the last day is whole', () => {
  assert.deepEqual(libraryRange({ from: '2026-11-04', to: '2026-11-04' }, 'America/New_York'), {
    from: '2026-11-04T05:00:00.000Z',
    to: '2026-11-05T05:00:00.000Z',
  })
  // Clocks change on 1 November in New York: that day has 25 hours.
  assert.deepEqual(libraryRange({ from: '2026-11-01', to: '2026-11-01' }, 'America/New_York'), {
    from: '2026-11-01T04:00:00.000Z',
    to: '2026-11-02T05:00:00.000Z',
  })
  assert.deepEqual(libraryRange({ to: '2026-11-04' }, 'UTC'), { to: '2026-11-05T00:00:00.000Z' })
  assert.deepEqual(libraryRange({}, 'UTC'), {})
})

test('date presets cover whole periods and honor the week start', () => {
  const wednesday = '2026-11-04'
  assert.deepEqual(datePreset('today', wednesday, 1), { from: wednesday, to: wednesday })
  assert.deepEqual(datePreset('week', wednesday, 1), { from: '2026-11-02', to: '2026-11-08' })
  assert.deepEqual(datePreset('week', wednesday, 0), { from: '2026-11-01', to: '2026-11-07' })
  assert.deepEqual(datePreset('month', '2028-02-10', 1), { from: '2028-02-01', to: '2028-02-29' })
})

test('the queue filter keeps rows for the account inside [from, to)', () => {
  const rows = [
    { accountIds: ['x'], at: '2026-11-04T05:00:00.000Z', id: 'first' },
    { accountIds: ['li'], at: '2026-11-04T06:00:00.000Z', id: 'other account' },
    { accountIds: ['x', 'li'], at: '2026-11-05T05:00:00.000Z', id: 'at the exclusive end' },
  ]
  const ids = (found: typeof rows) => found.map((row) => row.id)
  assert.equal(filterQueue(rows, undefined, {}).length, 3)
  assert.deepEqual(ids(filterQueue(rows, 'x', {})), ['first', 'at the exclusive end'])
  assert.deepEqual(
    ids(
      filterQueue(rows, 'x', { from: '2026-11-04T05:00:00.000Z', to: '2026-11-05T05:00:00.000Z' })
    ),
    ['first']
  )
})

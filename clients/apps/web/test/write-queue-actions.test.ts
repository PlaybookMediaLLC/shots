import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evenTimes,
  queueGroups,
  queueRuns,
  queueWarnings,
  shiftedTimes,
  spacedTimes,
  type QueueRow,
} from '@/lib/write/queue-actions'

const row = (over: Partial<QueueRow> & Pick<QueueRow, 'id' | 'at'>): QueueRow => ({
  accountIds: ['account-x'],
  caption: over.id,
  draftId: `draft-${over.id}`,
  kind: 'scheduled',
  title: '',
  ...over,
})

const at = (hour: number, minute = 0) =>
  `2026-11-06T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

test('moving a selection keeps the shape of the run', () => {
  const moved = shiftedTimes([row({ id: 'a', at: at(16) }), row({ id: 'b', at: at(17) })], 90)
  assert.equal(moved.get('a')?.toISOString(), at(17, 30))
  assert.equal(moved.get('b')?.toISOString(), at(18, 30))
})

test('spreading evenly puts the first at the start and the last at the end', () => {
  const spread = evenTimes(
    [row({ id: 'b', at: at(19) }), row({ id: 'a', at: at(16) }), row({ id: 'c', at: at(21) })],
    new Date(at(16)),
    new Date(at(22))
  )
  assert.deepEqual(
    [...spread.entries()].map(([id, when]) => [id, when.toISOString()]),
    [
      ['a', at(16)],
      ['b', at(19)],
      ['c', at(22)],
    ]
  )
})

test('spreading one post leaves it at the start', () => {
  const spread = evenTimes([row({ id: 'a', at: at(16) })], new Date(at(18)), new Date(at(22)))
  assert.equal(spread.get('a')?.toISOString(), at(18))
})

test('spacing a run puts an hour between its posts', () => {
  const spaced = spacedTimes(
    [row({ id: 'b', at: at(19) }), row({ id: 'a', at: at(16) })],
    new Date(at(16)),
    60
  )
  assert.equal(spaced.get('a')?.toISOString(), at(16))
  assert.equal(spaced.get('b')?.toISOString(), at(17))
})

test('posts written as one run are gathered, in time order', () => {
  const groups = queueGroups([
    row({ id: 'c', at: at(18), title: 'Other thing' }),
    row({ id: 'a', at: at(16), title: 'Storytelling \u00b7 1/3' }),
    row({ id: 'b', at: at(17), title: 'Storytelling \u00b7 2/3' }),
    row({ id: 'd', at: at(19), title: 'Storytelling \u00b7 3/3' }),
  ])
  assert.deepEqual(
    groups.map((group) => [group.name, group.rows.map((item) => item.id)]),
    [
      ['Storytelling', ['a', 'b', 'd']],
      [null, ['c']],
    ]
  )
})

test('a run of one is not a run', () => {
  const groups = queueGroups([row({ id: 'a', at: at(16), title: 'Storytelling \u00b7 1/7' })])
  assert.deepEqual(groups, [{ name: null, rows: [groups[0].rows[0]] }])
})

test('a run spread over two days is one run on each of them', () => {
  const whole = [
    row({ id: 'a', at: at(16), title: 'Storytelling \u00b7 1/3' }),
    row({ id: 'b', at: at(17), title: 'Storytelling \u00b7 2/3' }),
    row({ id: 'c', at: '2026-11-07T16:00:00.000Z', title: 'Storytelling \u00b7 3/3' }),
  ]
  const runs = queueRuns(whole)
  assert.deepEqual(
    runs.get('Storytelling')?.map((item) => item.id),
    ['a', 'b', 'c']
  )
  // The second day holds one of them; it is still the run, not a stray post.
  const secondDay = queueGroups([whole[2]], runs)
  assert.deepEqual(
    secondDay.map((group) => [group.name, group.rows.map((item) => item.id)]),
    [['Storytelling', ['c']]]
  )
})

test('a title that names no run groups nothing', () => {
  assert.equal(queueRuns([row({ id: 'a', at: at(16), title: 'Just a draft' })]).size, 0)
})

test('the same text from different drafts is a repeat; one draft on two accounts is not', () => {
  const repeat = queueWarnings(
    [
      row({ id: 'a', at: at(16), caption: 'Same thing' }),
      row({ id: 'b', at: at(20), caption: ' same   THING ' }),
    ],
    { minutesApart: 30 }
  )
  assert.deepEqual(
    repeat.map((item) => item.text),
    ['The same text is queued 2 times.']
  )

  const fanOut = queueWarnings(
    [
      { ...row({ id: 'a', at: at(16), caption: 'One post' }), draftId: 'd1' },
      {
        ...row({ id: 'b', at: at(20), caption: 'One post' }),
        accountIds: ['account-li'],
        draftId: 'd1',
      },
    ],
    { minutesApart: 30 }
  )
  assert.deepEqual(fanOut, [])
})

test('two posts to one account too close together are flagged once', () => {
  const warnings = queueWarnings(
    [
      row({ id: 'a', at: at(16, 0), caption: 'First' }),
      row({ id: 'b', at: at(16, 10), caption: 'Second' }),
      row({ id: 'c', at: at(23, 0), caption: 'Third' }),
    ],
    { minutesApart: 30 }
  )
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0].ids.sort(), ['a', 'b'])
})

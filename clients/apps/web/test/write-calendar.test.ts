import assert from 'node:assert/strict'
import test from 'node:test'
import {
  availableDaySlots,
  calendarRange,
  shiftCalendar,
  calendarMoveTime,
  queueDays,
  upcomingSlots,
} from '@/lib/write/calendar'

test('TF-053/081: month boundaries cover every day and preserve the chosen first weekday', () => {
  assert.deepEqual(calendarRange('2026-10-31', 'month', 1), {
    start: '2026-09-28',
    end: '2026-11-09',
    days: 42,
  })
  assert.equal(calendarRange('2026-11-01', 'month', 0).start, '2026-11-01')
  assert.equal(shiftCalendar('2026-01-31', 'month', 1), '2026-02-01')
  assert.equal(shiftCalendar('2026-12-31', 'month', 1), '2027-01-01')
})

test('TF-054/081: drops refuse DST ambiguity instead of silently changing the intended time', () => {
  assert.throws(
    () => calendarMoveTime('2026-11-01', '01:30', 'America/New_York'),
    /daylight saving/
  )
  assert.throws(
    () => calendarMoveTime('2027-03-14', '02:30', 'America/New_York'),
    /daylight saving/
  )
  assert.equal(
    calendarMoveTime('2026-11-02', '09:00', 'America/New_York').toISOString(),
    '2026-11-02T14:00:00.000Z'
  )
})

test('calendar offers only future, unoccupied slots on the selected brand day', () => {
  const slots = [
    { weekday: 2, time: '09:00' },
    { weekday: 2, time: '10:00' },
    { weekday: 2, time: '11:00' },
    { weekday: 2, time: '11:00' },
    { weekday: 3, time: '12:00' },
  ]
  assert.deepEqual(
    availableDaySlots(
      '2026-10-20',
      'America/New_York',
      slots,
      ['2026-10-20T14:03:00Z'],
      new Date('2026-10-20T13:30:00Z')
    ),
    ['11:00']
  )
})

test('calendar omits daylight saving gaps and ambiguous slots', () => {
  const slots = [
    { weekday: 0, time: '01:30' },
    { weekday: 0, time: '02:30' },
    { weekday: 0, time: '03:30' },
  ]
  assert.deepEqual(
    availableDaySlots('2027-03-14', 'America/New_York', slots, [], new Date('2027-01-01')),
    ['01:30', '03:30']
  )
  assert.deepEqual(
    availableDaySlots('2026-11-01', 'America/New_York', slots, [], new Date('2026-01-01')),
    ['02:30', '03:30']
  )
})

test('month calendar includes adjacent days and navigates leap and year boundaries', () => {
  assert.deepEqual(calendarRange('2028-02-29', 'month'), {
    start: '2028-01-31',
    end: '2028-03-13',
    days: 42,
  })
  assert.equal(shiftCalendar('2027-01-31', 'month', 1), '2027-02-01')
  assert.equal(shiftCalendar('2026-12-31', 'month', 1), '2027-01-01')
  assert.equal(calendarRange('2026-10-24', 'week', 0).start, '2026-10-18')
  assert.throws(() => calendarRange('2026-02-31', 'month'))
})

test('the next weekly slots are read in the brand zone, in order, with taken ones marked', () => {
  // Monday 2 November 2026, 13:00 UTC = 08:00 in New York.
  const now = new Date('2026-11-02T13:00:00Z')
  const slots = upcomingSlots(
    [
      { weekday: 1, time: '09:00' },
      { weekday: 1, time: '07:00' },
      { weekday: 2, time: '09:00' },
    ],
    'America/New_York',
    ['2026-11-03T14:00:00.000Z'],
    now
  )
  assert.deepEqual(
    slots.slice(0, 3).map((slot) => [slot.at.toISOString(), slot.busy]),
    [
      // Monday 07:00 has passed; 09:00 has not.
      ['2026-11-02T14:00:00.000Z', false],
      ['2026-11-03T14:00:00.000Z', true],
      ['2026-11-09T12:00:00.000Z', false],
    ]
  )
  assert.equal(slots.length, 8)
})

test('the queue shows seven days with each free weekly slot and the items that hold one', () => {
  // Wednesday 4 November 2026, 08:00 in New York; weekday slots at 09:00.
  const now = new Date('2026-11-04T13:00:00Z')
  const slots = [1, 2, 3, 4, 5].map((weekday) => ({ time: '09:00', weekday }))
  const queued = [{ at: '2026-11-05T14:02:00Z', id: 'thursday' }]
  const days = queueDays(slots, 'America/New_York', queued, now)
  assert.equal(days.length, 7)
  assert.deepEqual(
    days.map((day) => day.day),
    [
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]
  )
  assert.deepEqual(days[0].free, ['09:00'])
  // A natural-time post two minutes past the slot still holds it.
  assert.deepEqual(days[1].free, [])
  assert.deepEqual(days[1].items, queued)
  assert.equal(days[1].slots, 1)
  assert.deepEqual(days[3].free, [])
  assert.equal(days[3].slots, 0)
  const filled = days.reduce((sum, day) => sum + day.slots - day.free.length, 0)
  assert.equal(filled, 1)
  // A slot already past today is neither free nor counted.
  assert.equal(
    queueDays(slots, 'America/New_York', [], new Date('2026-11-04T15:00:00Z'))[0].slots,
    0
  )
})

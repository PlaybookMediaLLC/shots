import assert from 'node:assert/strict'
import test from 'node:test'
import { QUARTER_HOURS, formatTimeOfDay, parseTimeOfDay } from '@/lib/time-of-day'

test('times parse the way people type them', () => {
  const cases: Record<string, string> = {
    '9': '09:00',
    '9a': '09:00',
    '9 am': '09:00',
    '930p': '21:30',
    '9:30 PM': '21:30',
    '9.30pm': '21:30',
    '0930': '09:30',
    '2130': '21:30',
    '21:30': '21:30',
    '12a': '00:00',
    '12p': '12:00',
    noon: '12:00',
    midnight: '00:00',
  }
  for (const [input, expected] of Object.entries(cases))
    assert.equal(parseTimeOfDay(input), expected, input)
})

test('times that are not times parse to null', () => {
  for (const input of ['', '13p', '0a', '2460', '9:75', 'soon', '123456'])
    assert.equal(parseTimeOfDay(input), null, input)
})

test('times read on either clock', () => {
  assert.equal(formatTimeOfDay('21:30', true), '9:30 PM')
  assert.equal(formatTimeOfDay('00:05', true), '12:05 AM')
  assert.equal(formatTimeOfDay('12:00', true), '12:00 PM')
  assert.equal(formatTimeOfDay('21:30', false), '21:30')
  assert.equal(formatTimeOfDay('09:00', false), '09:00')
})

test('the quarter-hour list covers the day', () => {
  assert.equal(QUARTER_HOURS.length, 96)
  assert.equal(QUARTER_HOURS[0], '00:00')
  assert.equal(QUARTER_HOURS[36], '09:00')
  assert.equal(QUARTER_HOURS.at(-1), '23:45')
})

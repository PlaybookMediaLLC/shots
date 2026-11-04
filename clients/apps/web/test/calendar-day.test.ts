import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDayInput } from '@/lib/calendar-day'

const now = new Date(2026, 10, 4, 12)

test('days parse the way people type them', () => {
  const cases: Record<string, string> = {
    '2026-11-04': '2026-11-04',
    '11/4/2026': '2026-11-04',
    '11/4': '2026-11-04',
    'Nov 4': '2026-11-04',
    'nov 4, 2025': '2025-11-04',
    'November 4 2026': '2026-11-04',
    '4 Nov 2026': '2026-11-04',
    today: '2026-11-04',
    tomorrow: '2026-11-05',
    yesterday: '2026-11-03',
  }
  for (const [input, expected] of Object.entries(cases))
    assert.equal(parseDayInput(input, now), expected, input)
})

test('text that is not a day parses to null', () => {
  for (const input of ['', 'someday', '13/45/2026', '2026-02-30', 'Nov 40'])
    assert.equal(parseDayInput(input, now), null, input)
})

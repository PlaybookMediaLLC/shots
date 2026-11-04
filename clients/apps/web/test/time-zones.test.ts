import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultFilter } from 'cmdk'
import { zoneLabel, zoneOptions } from '@/lib/time-zones'

const january = new Date(Date.UTC(2026, 0, 15))

/** The zones a search shows, best first, as the picker's cmdk list ranks them. */
function found(search: string): string[] {
  return zoneOptions(undefined, january)
    .map((option) => ({
      option,
      score: defaultFilter(option.value, search, [option.label, ...option.keywords]),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ option }) => option.value)
}

test('zones are found by city, country and abbreviation', () => {
  assert.equal(found('Paris')[0], 'Europe/Paris')
  assert.equal(found('Tokyo')[0], 'Asia/Tokyo')
  assert.equal(found('France')[0], 'Europe/Paris')
  // Several zones keep Eastern Standard Time; New York leads them.
  assert.equal(found('EST')[0], 'America/New_York')
})

test('a zone reads as its city and offset, never its raw IANA name', () => {
  assert.equal(zoneLabel('America/New_York', january), 'New York · UTC−05:00')
  assert.equal(zoneLabel('Asia/Kolkata', january), 'Kolkata · UTC+05:30')
  for (const option of zoneOptions(undefined, january).filter(({ value }) => value !== 'UTC')) {
    assert.notEqual(option.label, option.value)
    assert.ok(!option.label.includes('/'), option.label)
    assert.equal(option.description, option.value)
  }
})

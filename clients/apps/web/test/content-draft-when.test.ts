import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWhen } from '@/lib/content-drafts/when'
import { draftVocabulary } from '@/lib/content-drafts/vocabulary'
import { xLength } from '@/lib/content-drafts/x-length'

// Sunday 18 October 2026, 10:30 local time.
const now = new Date(2026, 9, 18, 10, 30)
const local = (month: number, day: number, hours: number, minutes = 0, year = 2026) =>
  new Date(year, month, day, hours, minutes).getTime()

test('plain-language times read as the next matching moment', () => {
  const cases: [string, number | null][] = [
    ['in 3 hours', now.getTime() + 3 * 3_600_000],
    ['in an hour', now.getTime() + 3_600_000],
    ['in 2 days', now.getTime() + 2 * 86_400_000],
    ['+1h', now.getTime() + 3_600_000],
    ['+90m', now.getTime() + 90 * 60_000],
    ['+ 2 days', now.getTime() + 2 * 86_400_000],
    ['+h', null],
    ['tomorrow 9am', local(9, 19, 9)],
    ['tomorrow at 2:30pm', local(9, 19, 14, 30)],
    ['tomorrow', local(9, 19, 9)],
    ['today at 5pm', local(9, 18, 17)],
    ['tonight', local(9, 18, 20)],
    ['9am', local(9, 19, 9)],
    ['11:45', local(9, 18, 11, 45)],
    ['noon', local(9, 18, 12)],
    ['fri 2pm', local(9, 23, 14)],
    ['Monday', local(9, 19, 9)],
    ['sunday', local(9, 25, 9)],
    ['next saturday 10am', local(9, 24, 10)],
    ['saturday 9am', local(9, 24, 9)],
    ['oct 21 at noon', local(9, 21, 12)],
    ['21 oct 8:15am', local(9, 21, 8, 15)],
    ['10/1', local(9, 1, 9, 0, 2027)],
    ['feb 30', null],
    ['13pm', null],
    ['whenever', null],
    ['', null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(parseWhen(input, now)?.getTime() ?? null, expected, input)
  }
})

test('X lengths count links as 23 and wide characters as 2', () => {
  assert.equal(xLength('hello'), 5)
  assert.equal(xLength('see https://example.com/a/very/long/path?with=query.'), 4 + 23 + 1)
  assert.equal(xLength('www.example.com'), 23)
  assert.equal(xLength('日本語'), 6)
  assert.equal(xLength('🚀'), 2)
  assert.equal(xLength('👍🏽'), 2)
  assert.equal(xLength('👨‍👩‍👧'), 2)
  assert.equal(xLength('🇫🇷'), 2)
  assert.equal(xLength('café — “quoted”'), 15)
})

test('the vocabulary ranks handles and hashtags by use', () => {
  assert.deepEqual(
    draftVocabulary([
      'Launch with @shots_app #launch #SaaS',
      'Thanks @jane and @shots_app! #Launch, issue #1, a@b.com',
    ]),
    { handles: ['shots_app', 'jane'], hashtags: ['launch', 'SaaS'] }
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { measurePieces, pastePieces } from '@/lib/write/paste-split'
import { seriesName, seriesTitle, suggestedSeriesName } from '@/lib/write/series'

test('a blank line between ideas separates posts', () => {
  assert.deepEqual(pastePieces('One post.\n\nTwo posts.\n\n\nThree.'), [
    'One post.',
    'Two posts.',
    'Three.',
  ])
})

test('line breaks inside a piece are kept', () => {
  assert.deepEqual(pastePieces('Line one\nLine two\n\nNext'), ['Line one\nLine two', 'Next'])
})

test('a rule of dashes separates as a blank line does', () => {
  assert.deepEqual(pastePieces('One\n---\nTwo\n\n----  \nThree'), ['One', 'Two', 'Three'])
})

test('windows line endings and trailing blank space do not make empty posts', () => {
  assert.deepEqual(pastePieces('One\r\n\r\n   \r\nTwo\r\n\r\n'), ['One', 'Two'])
})

test('one block of prose stays one piece', () => {
  assert.deepEqual(pastePieces('Just one thought, written out.'), [
    'Just one thought, written out.',
  ])
})

test('pieces are measured as the platform counts, against its standard limit', () => {
  const [plain, link, long] = measurePieces(
    ['hello', 'see https://example.com/a/very/long/path?with=query', 'x'.repeat(281)],
    'x'
  )
  assert.equal(plain.length, 5)
  assert.equal(plain.over, false)
  assert.equal(link.length, 4 + 23)
  assert.equal(long.over, true)
})

test('a run is held together by the title its drafts share', () => {
  assert.equal(seriesTitle('Storytelling', 2, 7), 'Storytelling · 3/7')
  assert.equal(seriesName('Storytelling · 3/7'), 'Storytelling')
  assert.equal(seriesName('Storytelling'), null)
  assert.equal(seriesName(null), null)
  // A name that itself holds the mark still resolves to the whole name.
  assert.equal(seriesName('Launch · week two · 1/4'), 'Launch · week two')
})

test('a series is named from the run\u2019s first words, never mid-word', () => {
  assert.equal(suggestedSeriesName('Storytelling is how we sell.\nSecond line.'), 'Storytelling is how we sell.')
  assert.equal(
    suggestedSeriesName(
      'A much longer opening line that runs past the suggestion limit comfortably'
    ),
    'A much longer opening line that runs past the'
  )
  assert.equal(suggestedSeriesName('   '), 'Series')
})

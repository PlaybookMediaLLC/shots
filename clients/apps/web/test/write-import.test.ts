import assert from 'node:assert/strict'
import test from 'node:test'
import { importedBody, importedPosts, splitThread } from '@/lib/write/import-text'
import { xLength } from '@/lib/content-drafts/x-length'

test('URL text preserves literal markup and percent values as ordinary text', () => {
  const posts = importedPosts('<script>alert(1)</script> 100%\r\n---\r\nSecond\nparagraph')
  assert.deepEqual(posts, ['<script>alert(1)</script> 100%', 'Second\nparagraph'])
  assert.equal(importedBody(posts).filter((block) => block.type === 'post_break').length, 2)
  assert.equal((importedBody(posts)[1].children as { text: string }[])[0].text, posts[0])
})
test('thread split uses weighted URLs and preserves grapheme sequences', () => {
  const url = `https://example.com/${'path'.repeat(100)}`
  const posts = splitThread(`Start ${url} End`, 'x', 25)
  assert.ok(posts.includes(url))
  assert.ok(posts.every((post) => xLength(post) <= 25))
  const family = '👩‍👩‍👧‍👦'
  // Bluesky counts graphemes: a family is one.
  assert.deepEqual(splitThread(family.repeat(60), 'bluesky', 25), [
    family.repeat(25),
    family.repeat(25),
    family.repeat(10),
  ])
  // Mastodon counts a short link as 23, so it does not fit beside other text at 23.
  assert.deepEqual(splitThread('a https://x.com', 'mastodon', 23), ['a', 'https://x.com'])
  // LinkedIn counts UTF-16 units: a family is 11, and is never cut.
  assert.deepEqual(splitThread(family.repeat(5), 'linkedin', 23), [
    family.repeat(2),
    family.repeat(2),
    family,
  ])
})
test('thread split counts the spaces between words and cuts a long word at the longest piece', () => {
  // X counts an ideographic space as 2: ten, the space and eleven make 23.
  const words = (last: number) => `${'a'.repeat(10)}\u3000${'b'.repeat(last)}`
  assert.deepEqual(splitThread(words(11), 'x', 23), [words(11)])
  assert.deepEqual(splitThread(words(12), 'x', 23), ['a'.repeat(10), 'b'.repeat(12)])
  // X counts each of these characters as 2, so a run with no spaces is cut
  // every 11, and the last piece counts toward the next word.
  const text = '日本語'.repeat(10)
  assert.deepEqual(splitThread(`${text} ${'c'.repeat(7)}`, 'x', 23), [
    text.slice(0, 11),
    text.slice(11, 22),
    text.slice(22),
    'c'.repeat(7),
  ])
  // X finds no link right after U+FEFF, so the link counts in full beside it.
  const link = `https://example.com/${'b'.repeat(300)}`
  assert.deepEqual(splitThread(`a\ufeff${link}`, 'x', 280), ['a', link])
})
test('imports enforce the thread and input size limits', () => {
  assert.throws(() => importedPosts(Array(26).fill('post').join('\n---\n')), /25 posts/)
  assert.throws(() => splitThread('a'.repeat(100001), 'x', 280), /100,000/)
  assert.throws(() => splitThread('post', 'x', NaN), /post length/)
  // One grapheme of 31 units is longer than any LinkedIn post at 23.
  assert.throws(
    () => splitThread(`ok a${'\u0301'.repeat(30)}`, 'linkedin', 23),
    /character sequence/
  )
  assert.throws(() => splitThread('a'.repeat(1000), 'x', 23), /25 posts/)
  assert.deepEqual(importedPosts('one\n\nparagraph\n\n\n\ntwo'), ['one\n\nparagraph', 'two'])
})

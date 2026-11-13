import assert from 'node:assert/strict'
import test from 'node:test'
import { importedBody, importedPosts, splitThread } from '@/lib/write/import-text'
import { xLength } from '@/lib/content-drafts/x-length'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'

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
  // Mastodon counts a link as 23, however short: three of these are over 50.
  const links = 'https://t.co/a '.repeat(10).trim()
  const toots = splitThread(links, 'mastodon', 50)
  assert.ok(toots.every((post) => platformCaptionLength('mastodon', post) <= 50))
  assert.equal(toots.length, 5)
  // A word too long for a post is cut, but never inside a link: it counts 23 whole.
  assert.deepEqual(splitThread('abhttps://example.com/x', 'mastodon', 23), [
    'ab',
    'https://example.com/x',
  ])
  for (const text of ['a'.repeat(40) + 'https://t.co/a', '日本語'.repeat(161) + 'https://t.co/a'])
    for (const post of splitThread(text, 'mastodon', 50))
      assert.ok(platformCaptionLength('mastodon', post) <= 50, post)
  // LinkedIn counts UTF-16 units: a family is 11, and is never cut.
  assert.deepEqual(splitThread(family.repeat(5), 'linkedin', 23), [
    family.repeat(2),
    family.repeat(2),
    family,
  ])
})
test('imports enforce the thread and input size limits', () => {
  assert.throws(() => importedPosts(Array(26).fill('post').join('\n---\n')), /25 posts/)
  assert.throws(() => splitThread('a'.repeat(100001), 'x', 280), /100,000/)
  assert.throws(() => splitThread('post', 'x', NaN), /post length/)
  assert.throws(() => splitThread('a'.repeat(1000), 'x', 23), /25 posts/)
  assert.deepEqual(importedPosts('one\n\nparagraph\n\n\n\ntwo'), ['one\n\nparagraph', 'two'])
})

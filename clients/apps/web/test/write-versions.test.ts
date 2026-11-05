import assert from 'node:assert/strict'
import test from 'node:test'
import { POST_BREAK, serializeDraft } from '@/lib/content-drafts/serialize'
import type { PlateBody } from '@/lib/write/document'
import {
  adaptBody,
  bodyFor,
  bodyPosts,
  forkVersion,
  groupSettings,
  normalizePosts,
  primaryChanged,
  readVersions,
  resyncVersion,
  versionFor,
  withOptions,
  otherPlatformNamed,
} from '@/lib/write/versions'

const p = (text: string, marks: object = {}) => ({ children: [{ text, ...marks }], type: 'p' })
const brk = (extra: object = {}) => ({ children: [{ text: '' }], type: POST_BREAK, ...extra })
const thread: PlateBody = [
  brk({ id: 'a' }),
  p('One'),
  brk({ id: 'b', replySettings: 'following' }),
  p('Two'),
  brk({ id: 'c' }),
  p('Three'),
]

test('a body gains one leading break and unique ids', () => {
  const legacy: PlateBody = [p('Hello'), brk(), p('World')]
  const normal = normalizePosts(legacy)
  assert.equal(normal[0].type, POST_BREAK)
  const ids = normal.filter((node) => node.type === POST_BREAK).map((node) => node.id)
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 2)
  // Two leading breaks (two editors at once) collapse to one.
  const doubled = normalizePosts([brk({ id: 'x' }), brk({ id: 'y' }), p('Hi')])
  assert.deepEqual(
    doubled.map((node) => node.id ?? node.type),
    ['x', 'p']
  )
  // A duplicated id gets a fresh one.
  const duplicate = normalizePosts([brk({ id: 'x' }), p('a'), brk({ id: 'x' }), p('b')])
  assert.notEqual(duplicate[0].id, duplicate[2].id)
  // A normalized body serializes exactly as before.
  assert.deepEqual(
    serializeDraft(normal, 'x').posts.map((post) => post.caption),
    serializeDraft(legacy, 'x').posts.map((post) => post.caption)
  )
})

test('posts carry their id and settings; serializer groups map back to them', () => {
  const posts = bodyPosts(thread)
  assert.deepEqual(
    posts.map((post) => [post.id, post.blocks.length]),
    [
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]
  )
  assert.equal(posts[1].settings.replySettings, 'following')
  const settings = groupSettings(thread)
  const serialized = serializeDraft(thread, 'x').posts
  assert.deepEqual(
    serialized.map((post) => settings[post.group].id),
    ['a', 'b', 'c']
  )
  // Joined into one LinkedIn post, the post takes the first post's settings.
  const linkedin = serializeDraft(thread, 'linkedin').posts
  assert.equal(linkedin.length, 1)
  assert.equal(settings[linkedin[0].group].id, 'a')
})

test('legacy per-channel text reads as a manual version and keeps the body images', () => {
  const image = { assetId: 'cimage000001', children: [{ text: '' }], type: 'img' }
  const versions = readVersions(undefined, { linkedin: 'Own words\n\n\nSecond post' }, [
    p('Body'),
    image,
  ])
  const linkedin = versionFor(versions, 'linkedin')
  assert.equal(linkedin.mode, 'manual')
  assert.deepEqual(
    serializeDraft(linkedin.body, 'x').posts.map((post) => post.caption),
    ['Own words', 'Second post']
  )
  assert.deepEqual(serializeDraft(linkedin.body, 'x').posts[0].assetIds, ['cimage000001'])
  assert.equal(versionFor(versions, 'x').mode, 'synced')
})

test('a manual version survives primary edits, and divergence is noticed', () => {
  const forked = forkVersion(readVersions(undefined), 'linkedin', thread, 4, false)
  const linkedin = versionFor(forked, 'linkedin')
  assert.equal(linkedin.mode, 'manual')
  assert.equal(linkedin.forkedFromVersion, 4)
  // LinkedIn takes the thread as one post: one break, every block.
  assert.equal(linkedin.body?.filter((node) => node.type === POST_BREAK).length, 1)
  assert.equal(serializeDraft(linkedin.body, 'linkedin').caption, 'One\n\nTwo\n\nThree')
  assert.equal(primaryChanged(linkedin, thread, 'linkedin'), false)
  // The person rewrites LinkedIn; the primary moves on.
  const rewritten = withOptions(
    { ...forked, versions: [{ ...linkedin, body: [brk({ id: 'l' }), p('LinkedIn words')] }] },
    'linkedin',
    { visibility: 'CONNECTIONS' }
  )
  const editedPrimary: PlateBody = [...thread, brk({ id: 'd' }), p('Four')]
  assert.equal(
    serializeDraft(bodyFor(editedPrimary, rewritten, 'linkedin'), 'linkedin').caption,
    'LinkedIn words'
  )
  assert.equal(versionFor(rewritten, 'linkedin').options?.visibility, 'CONNECTIONS')
  assert.equal(primaryChanged(versionFor(rewritten, 'linkedin'), editedPrimary, 'linkedin'), true)
  // A synced channel follows the primary.
  assert.equal(serializeDraft(bodyFor(editedPrimary, rewritten, 'x'), 'x').posts.length, 4)
})

test('re-syncing is explicit and names the comment threads it orphans', () => {
  const manual = readVersions({
    schemaVersion: 1,
    versions: [
      {
        body: [brk({ id: 'l' }), p('Commented', { comment: true, comment_t1: true })],
        channel: 'linkedin',
        mode: 'manual',
        options: { firstComment: 'Link below' },
      },
    ],
  })
  const { orphaned, versions } = resyncVersion(manual, 'linkedin')
  assert.deepEqual(orphaned, ['t1'])
  const linkedin = versionFor(versions, 'linkedin')
  assert.equal(linkedin.mode, 'synced')
  assert.equal(linkedin.body, undefined)
  // Options stay: they are settings, not text.
  assert.equal(linkedin.options?.firstComment, 'Link below')
})

test('adapting for a thread platform keeps posts but gives them new ids', () => {
  const adapted = adaptBody(thread, true)
  const breaks = adapted.filter((node) => node.type === POST_BREAK)
  assert.equal(breaks.length, 3)
  assert.ok(breaks.every((node) => !['a', 'b', 'c'].includes(String(node.id))))
  assert.equal(breaks[1].replySettings, 'following')
})

test("copy naming another of the draft's platforms is caught, without flagging common words", () => {
  const channels = ['tiktok', 'x'] as const
  assert.equal(otherPlatformNamed('Made with Shots, published to TikTok', 'x', channels), 'TikTok')
  assert.equal(otherPlatformNamed('Made with Shots, published to TikTok', 'tiktok', channels), null)
  assert.equal(otherPlatformNamed('Now on X as well', 'tiktok', channels), 'X')
  assert.equal(otherPlatformNamed('Factor X matters', 'tiktok', channels), null)
  assert.equal(otherPlatformNamed('How to x-ray a release', 'tiktok', channels), null)
  // A link to a platform is not copy about it.
  assert.equal(otherPlatformNamed('Watch https://tiktok.com/@a/video/1', 'x', channels), null)
  assert.equal(otherPlatformNamed('Watch tiktok.com/@a', 'x', channels), null)
  assert.equal(otherPlatformNamed('It is on TikTok.', 'x', channels), 'TikTok')
  // A platform this draft does not post to is ordinary copy.
  assert.equal(otherPlatformNamed('Follow us on LinkedIn', 'x', channels), null)
})

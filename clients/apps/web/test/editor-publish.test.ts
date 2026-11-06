import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesignCopy } from '@/lib/captions/channels'
import {
  accountsOn,
  captionChannelText,
  captionFor,
  captionsOverLimit,
  designMediaProblems,
  designPostBody,
  isPublishChannel,
  primaryFor,
  PUBLISH_CHANNELS,
} from '@/lib/editor/publish'
import { PUBLISH_MEDIA_TYPE } from '@/lib/editor/publish-drafts'

/**
 * The seam between the editor's captions and Publish's drafts: which
 * platforms a design can go to, which caption each one posts, and what the
 * created draft holds.
 */

const copy: DesignCopy = {
  altText: 'A dashboard screenshot',
  captions: {
    instagram: 'For Instagram',
    linkedin: 'For LinkedIn',
    x: 'For X',
  },
}

test('only platforms with both a caption and a publishing adapter are offered', () => {
  // Facebook has caption conventions but nothing publishes it; TikTok and
  // YouTube publish but the editor writes no caption for them.
  assert.deepEqual([...PUBLISH_CHANNELS], ['x', 'linkedin', 'instagram', 'threads', 'bluesky'])
  assert.equal(isPublishChannel('facebook'), false)
  assert.equal(isPublishChannel('tiktok'), false)
  assert.equal(captionFor(copy, 'tiktok'), '')
})

test('the post body is the caption of a platform that has one', () => {
  // Threads is chosen first but has no caption, so LinkedIn writes the body
  // and Threads falls back to it as a synced version.
  assert.equal(primaryFor(['threads', 'linkedin'], copy), 'linkedin')
  assert.equal(primaryFor(['threads', 'bluesky'], copy), 'threads')
  assert.equal(primaryFor([], copy), 'x')
})

test('every other chosen platform keeps the caption written for it', () => {
  const text = captionChannelText(copy, ['x', 'linkedin', 'instagram', 'threads'], 'x')

  // The primary's caption is the body, so it is not repeated; a platform
  // with no caption of its own posts the body rather than an empty string.
  assert.deepEqual(text, { instagram: 'For Instagram', linkedin: 'For LinkedIn' })
  assert.deepEqual(captionChannelText(null, ['x', 'linkedin'], 'x'), {})
})

test('the draft opens with the caption and then the exported image', () => {
  const body = designPostBody({
    altText: copy.altText,
    assets: [{ id: 'asset1234567', mediaType: 'image/png' }],
    caption: 'For X',
  })

  assert.equal(body.length, 3)
  assert.deepEqual(body[1], { children: [{ text: 'For X' }], type: 'p' })
  assert.equal(body[2]?.type, 'img')
  assert.equal(body[2]?.assetId, 'asset1234567')
  // The provider reads the description from the node, not the asset, so the
  // alt text the Captions panel wrote has to be on it.
  assert.equal(body[2]?.alt, 'A dashboard screenshot')
})

test('a caption over its limit is reported the way the platform counts it', () => {
  const link = `Read it: https://${'a'.repeat(300)}.example.com`
  const long: DesignCopy = { captions: { linkedin: 'Short enough', x: link } }

  // X counts any link as 23 characters, so this one fits despite its length.
  assert.deepEqual(captionsOverLimit(long, ['x', 'linkedin']), [])
  assert.deepEqual(captionsOverLimit({ captions: { x: 'x'.repeat(281) } }, ['x']), [
    { channel: 'x', length: 281, limit: 280 },
  ])
})

test('a canvas shape a chosen platform refuses is reported before anything renders', () => {
  const story = { height: 1920, mimeType: PUBLISH_MEDIA_TYPE, width: 1080 }
  const wide = { height: 1080, mimeType: PUBLISH_MEDIA_TYPE, width: 1920 }

  // Instagram takes 0.8–1.91; a 9:16 story is 0.5625, a 16:9 banner 1.78.
  assert.deepEqual(designMediaProblems(['x', 'linkedin'], story), [])
  assert.deepEqual(designMediaProblems(['instagram'], wide), [])
  const refused = designMediaProblems(['x', 'instagram'], story)
  assert.equal(refused.length, 1)
  assert.match(refused[0]!, /Instagram/)
})

test('a design is posted only from accounts the workspace has', () => {
  const accounts = [
    { channel: 'x' as const, id: 'c1', name: '@one' },
    { channel: 'x' as const, id: 'c2', name: '@two' },
    { channel: 'linkedin' as const, id: 'c3', name: 'Company' },
  ]

  assert.deepEqual(
    accountsOn(accounts, ['linkedin', 'x', 'instagram']).map((account) => account.id),
    ['c3', 'c1', 'c2']
  )
  assert.deepEqual(accountsOn(accounts, ['instagram']), [])
})

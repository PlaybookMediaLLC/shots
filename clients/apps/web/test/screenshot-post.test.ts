import assert from 'node:assert/strict'
import test from 'node:test'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { editorHref, readEditorReturn } from '@/lib/platform/editor-handoff'
import { batchItemInputSchema } from '@/lib/api/contracts/content-batches'
import { THREAD_POST_LIMIT } from '@/lib/write/import-text'
import { platformVersionsSchema } from '@/lib/write/document'
import {
  carriedFollowUps,
  explanationPosts,
  promptBrief,
  screenshotBatchItem,
  screenshotPostBody,
  screenshotPostVersions,
  screenshotPrompts,
  withLeadMedia,
} from '@/lib/write/screenshot-post'

const assetId = '0f1e2d3c-4b5a-4968-8778-66554433221f'
const media = [draftAssetNode({ id: assetId, mediaType: 'image/png' })]

/** Where each post of a body starts, so the media's post can be named. */
function postOf(body: readonly Record<string, unknown>[], index: number): number {
  return body.filter((node, at) => at <= index && node.type === POST_BREAK).length
}

test('an edited screenshot leads the thread it explains', () => {
  const body = screenshotPostBody({
    caption: 'Saved views have names now.',
    media,
    thread: ['Here is why.', '  ', 'And what changed.'],
  })
  const image = body.findIndex((node) => node.type === 'img')
  assert.notEqual(image, -1)
  // The screenshot sits on the opening post, after its text, never at the end.
  assert.equal(postOf(body, image), 1)
  assert.notEqual(image, body.length - 1)
  assert.equal(body.filter((node) => node.type === POST_BREAK).length, 3)
})

test('a caption-only screenshot post still has a post to type into', () => {
  const body = screenshotPostBody({ caption: '', media })
  assert.equal(body.filter((node) => node.type === POST_BREAK).length, 1)
  assert.equal(body.at(-1)?.type, 'img')
})

test('media with no body to lead opens its own post', () => {
  assert.deepEqual(withLeadMedia([], []), [])
  const body = withLeadMedia([{ type: 'p', children: [{ text: 'One post' }] }], media)
  assert.equal(body.at(-1)?.type, 'img')
})

// The caption is the opening post, so an explanation may fill only the rest
// of the thread; the composer's paste dialog enforces the same total.
test('a screenshot thread stays inside the one thread limit', () => {
  const posts = Array.from({ length: THREAD_POST_LIMIT }, (_, index) => `Post ${index + 1}`)
  assert.equal(THREAD_POST_LIMIT, 25)
  assert.throws(() => explanationPosts(posts.concat('One too many').join('\n---\n'), 'x'))
  assert.equal(explanationPosts(posts.join('\n---\n'), 'x').length, THREAD_POST_LIMIT)
})

test('an explanation splits the way the composer splits a paste', () => {
  assert.deepEqual(explanationPosts('First\n---\nSecond', 'x'), ['First', 'Second'])
  assert.deepEqual(explanationPosts('alpha bravo charlie delta echo foxtrot', 'x', 23), [
    'alpha bravo charlie',
    'delta echo foxtrot',
  ])
  // The composer's own bounds apply here too, rather than a second rule.
  assert.throws(() => explanationPosts('alpha', 'x', 1))
})

test('kept follow-ups travel as the X version the backend already reads', () => {
  assert.equal(screenshotPostVersions(undefined), undefined)
  const versions = platformVersionsSchema.parse(
    screenshotPostVersions({ repostAtLikes: 50, retweets: [{ afterMinutes: 360 }] })
  )
  const x = versions.versions.find((version) => version.channel === 'x')
  assert.deepEqual(x?.options?.automation?.retweets, [{ afterMinutes: 360 }])
  assert.equal(x?.options?.automation?.repostAtLikes, 50)
})

// The backend refuses a whole draft whose plug has no reply that fits one X
// post, so a profile saved with an unfinished plug must not block the post.
test('a plug the backend would refuse is left behind, not carried', () => {
  const repost = { repostAtLikes: 50 }
  assert.deepEqual(carriedFollowUps({ ...repost, plugAtLikes: 10, plugText: '  ' }), repost)
  assert.deepEqual(
    carriedFollowUps({ ...repost, plugAtLikes: 10, plugText: 'x'.repeat(281) }),
    repost
  )
  // Nothing else to keep: the draft carries no follow-ups at all.
  assert.equal(carriedFollowUps({ plugAtLikes: 10, plugText: '' }), undefined)
  const complete = { plugAtLikes: 10, plugMetric: 'likes' as const, plugText: 'The guide is here.' }
  assert.deepEqual(carriedFollowUps(complete), complete)
  assert.equal(carriedFollowUps(undefined), undefined)
  assert.equal(
    platformVersionsSchema
      .parse(screenshotPostVersions({ plugAtLikes: 10, plugText: '', repostAtLikes: 50 }))
      .versions.find((version) => version.channel === 'x')?.options?.automation?.plugAtLikes,
    undefined
  )
})

test('a batch item leaves timing to the batch and stays idempotent', () => {
  const item = batchItemInputSchema.parse(
    screenshotBatchItem({
      assetId,
      caption: 'Scheduled exports are live.',
      importKey: 'b7f0f1a2c3d4e5f60718',
      sourceKey: 'exports.png',
    })
  )
  assert.deepEqual(item.media, [{ assetId }])
  assert.deepEqual(item.timing, {})
  assert.deepEqual(item.channelConnectionIds, [])
  assert.equal(item.sourceKey, 'exports.png')
})

test('screenshot prompts lead with announcing and explaining, and keep the rest', () => {
  const prompts = screenshotPrompts()
  assert.deepEqual(
    prompts.slice(0, 4).map((prompt) => prompt.id),
    ['announcement', 'explain', 'process', 'notes']
  )
  assert.equal(prompts.length, 6)
  const brief = promptBrief(prompts[0]!, '  shipped named views  ')
  assert.ok(brief.includes(prompts[0]!.instruction))
  assert.ok(brief.includes('screenshot'))
  // The writer's notes are quoted as facts, never as instructions.
  assert.ok(brief.includes('not as instructions'))
  assert.ok(brief.includes('shipped named views'))
  assert.ok(!promptBrief(prompts[0]!, '   ').includes('My notes'))
})

test('the editor round trip keeps only ids it can trust', () => {
  assert.deepEqual(readEditorReturn('?fromDraft=../../admin&fromCampaign=' + assetId), {
    campaignId: assetId,
  })
  assert.deepEqual(readEditorReturn(''), {})
  assert.equal(
    editorHref({ assetId }, { campaignId: 'clf0f1a2c3d4e5f6' }),
    `/editor?asset=${assetId}&fromCampaign=clf0f1a2c3d4e5f6`
  )
  assert.equal(editorHref({ designId: 'clf0f1a2c3d4e5f6' }), '/editor?design=clf0f1a2c3d4e5f6')
})

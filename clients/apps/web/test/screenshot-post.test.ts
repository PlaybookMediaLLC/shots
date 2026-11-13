import assert from 'node:assert/strict'
import test from 'node:test'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { editorHref, readEditorBrandKit, readEditorReturn } from '@/lib/platform/editor-handoff'
import { batchItemInputSchema } from '@/lib/api/contracts/content-batches'
import { THREAD_POST_LIMIT } from '@/lib/write/import-text'
import { platformVersionsSchema } from '@/lib/write/document'
import type { DesignCopy } from '@/lib/captions/channels'
import {
  accountsOn,
  CAPTIONED_CHANNELS,
  captionChannelText,
  captionFor,
  captionsOverLimit,
  carriedFollowUps,
  explanationPosts,
  isCaptionedChannel,
  platformAcceptsSize,
  platformTarget,
  postAccounts,
  postRenders,
  primaryFor,
  promptBrief,
  screenshotBatchItem,
  screenshotMediaProblems,
  screenshotPostBody,
  screenshotPostVersions,
  screenshotPrompts,
  withLeadMedia,
  withPlatformMedia,
} from '@/lib/write/screenshot-post'
import { CANVAS_TARGET_ID } from '@/lib/export/sizes'
import { draftChannelSchema } from '@/lib/write/document'
import { bodyFor, versionFor } from '@/lib/write/versions'

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
  assert.equal(screenshotPostVersions({}), undefined)
  const versions = platformVersionsSchema.parse(
    screenshotPostVersions({
      automation: { repostAtLikes: 50, retweets: [{ afterMinutes: 360 }] },
    })
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
      .parse(
        screenshotPostVersions({
          automation: { plugAtLikes: 10, plugText: '', repostAtLikes: 50 },
        })
      )
      .versions.find((version) => version.channel === 'x')?.options?.automation?.plugAtLikes,
    undefined
  )
})

// Built apart, the follow-ups' X entry made `readVersions` skip X's caption.
test("X keeps both its own caption and the profile's follow-ups", () => {
  const body = screenshotPostBody({ caption: 'For LinkedIn', media })
  const versions = platformVersionsSchema.parse(
    screenshotPostVersions({
      automation: { repostAtLikes: 50 },
      body,
      channelText: { x: 'For X' },
    })
  )
  const x = versions.versions.find((version) => version.channel === 'x')
  assert.equal(x?.mode, 'manual')
  assert.equal(x?.options?.automation?.repostAtLikes, 50)
  const blocks = (x?.body ?? []) as Record<string, unknown>[]
  assert.ok(JSON.stringify(blocks).includes('For X'))
  // Its own version carries the screenshot too, not only the body's.
  assert.ok(blocks.some((node) => node.type === 'img' && node.assetId === assetId))
})

test('a screenshot carries its description to the provider', () => {
  const body = screenshotPostBody({ altText: '  A dashboard  ', caption: 'New', media })
  // The serializer reads the description from the node, not the asset.
  assert.equal(body.find((node) => node.type === 'img')?.alt, 'A dashboard')
  assert.equal(
    screenshotPostBody({ caption: 'New', media }).find((node) => node.type === 'img')?.alt,
    undefined
  )
})

const copy: DesignCopy = {
  altText: 'A dashboard screenshot',
  captions: { instagram: 'For Instagram', linkedin: 'For LinkedIn', x: 'For X' },
}

test('captions attach only where both a caption and a publisher exist', () => {
  // Mastodon, TikTok, YouTube and Pinterest publish but get no written caption.
  assert.deepEqual(
    [...CAPTIONED_CHANNELS],
    ['x', 'linkedin', 'instagram', 'threads', 'bluesky', 'facebook']
  )
  assert.equal(isCaptionedChannel('facebook'), true)
  assert.equal(isCaptionedChannel('pinterest'), false)
  assert.equal(captionFor(copy, 'mastodon'), '')
  assert.equal(captionFor(copy, 'pinterest'), '')
})

// A provider platform is not a draft channel: company pages and standalone
// Instagram accounts were dropped when they were compared as one.
test('every account a draft can post from is offered, under its channel', () => {
  const account = (id: string, platform: string) => ({
    displayName: null,
    handle: `@${id}`,
    id,
    platform,
  })
  assert.deepEqual(
    postAccounts([
      account('page', 'linkedin-page'),
      account('solo', 'instagram-standalone'),
      account('old', 'twitter'),
      account('masto', 'mastodon'),
      account('fb', 'facebook'),
      // Google Business is not a draft channel yet, so its account is not offered.
      account('local', 'gmb'),
    ]).map((item) => [item.id, item.channel]),
    [
      ['page', 'linkedin'],
      ['solo', 'instagram'],
      ['old', 'x'],
      ['masto', 'mastodon'],
      ['fb', 'facebook'],
    ]
  )
  const accounts = postAccounts([account('a', 'x'), account('b', 'linkedin')])
  assert.deepEqual(
    accountsOn(accounts, ['linkedin', 'x', 'threads']).map((item) => item.id),
    ['b', 'a']
  )
})

test('the post opens with a caption written for a chosen platform', () => {
  // Threads is chosen first but has no caption, so LinkedIn writes the body.
  assert.equal(primaryFor(['threads', 'linkedin'], copy), 'linkedin')
  assert.equal(primaryFor(['threads', 'bluesky'], copy), 'threads')
  assert.equal(primaryFor([], copy, 'linkedin'), 'linkedin')
  // The body's caption is not repeated; a platform without its own posts the body.
  assert.deepEqual(captionChannelText(copy, ['x', 'linkedin', 'instagram', 'threads'], 'x'), {
    instagram: 'For Instagram',
    linkedin: 'For LinkedIn',
  })
  assert.deepEqual(captionChannelText(null, ['x', 'linkedin'], 'x'), {})
})

test('each platform is measured against the text it will post', () => {
  const link = `Read it: https://example.com/${'a'.repeat(300)}`
  // X counts any link it recognizes as 23 characters, so this one fits despite its length.
  assert.deepEqual(captionsOverLimit({ body: link, channels: ['x'], copy: null, primary: 'x' }), [])
  assert.deepEqual(
    captionsOverLimit({ body: 'x'.repeat(281), channels: ['x'], copy: null, primary: 'x' }),
    [{ channel: 'x', length: 281, limit: 280, reused: false }]
  )
  // Bluesky has no caption of its own, so it posts the 400-character body.
  assert.deepEqual(
    captionsOverLimit({
      body: 'a'.repeat(400),
      channels: ['linkedin', 'bluesky'],
      copy: null,
      primary: 'linkedin',
    }),
    [{ channel: 'bluesky', length: 400, limit: 300, reused: true }]
  )
  // With a short caption of its own, it posts that instead.
  assert.deepEqual(
    captionsOverLimit({
      body: 'a'.repeat(400),
      channels: ['linkedin', 'bluesky'],
      copy: { captions: { bluesky: 'Short' } },
      primary: 'linkedin',
    }),
    []
  )
})

test('the sheet counts its captions in a worker that answers the same way', async (t) => {
  let listener: ((event: { data: unknown }) => void) | undefined
  const replies: unknown[] = []
  const worker = {
    addEventListener: (_: 'message', handler: typeof listener) => (listener = handler),
    postMessage: (message: unknown) => replies.push(message),
  }
  for (const [name, value] of Object.entries(worker)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { configurable: true, value })
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
  await import('@/lib/write/caption-count.worker')
  listener!({ data: { body: 'x'.repeat(281), channels: ['x'], copy: null, primary: 'x' } })
  assert.deepEqual(replies, [[{ channel: 'x', length: 281, limit: 280, reused: false }]])
})

test('a shape a chosen platform refuses is reported before anything renders', () => {
  const story = { height: 1920, mimeType: 'image/jpeg', width: 1080 }
  const wide = { height: 1080, mimeType: 'image/jpeg', width: 1920 }
  // Instagram takes 0.8–1.91; a 9:16 story is 0.5625, a 16:9 banner 1.78.
  assert.deepEqual(screenshotMediaProblems(['x', 'linkedin'], story), [])
  assert.deepEqual(screenshotMediaProblems(['instagram'], wide), [])
  const refused = screenshotMediaProblems(['x', 'instagram'], story)
  assert.equal(refused.length, 1)
  assert.match(refused[0]!, /Instagram/)
})

test('every platform has an export size its own media rules accept', () => {
  for (const channel of draftChannelSchema.options) {
    const target = platformTarget(channel)
    assert.notEqual(target.id, CANVAS_TARGET_ID, channel)
    // Only a platform the editor writes a caption for is ever drawn for.
    if (!isCaptionedChannel(channel)) continue
    assert.ok(platformAcceptsSize(channel, target), channel)
  }
  // Instagram keeps 0.8-1.91 and 320px, which a story shape fails.
  assert.equal(platformAcceptsSize('instagram', { height: 1920, width: 1080 }), false)
  assert.equal(platformAcceptsSize('x', { height: 1920, width: 1080 }), true)
})

test('platforms that read the same shape share one render', () => {
  // X, Bluesky and Mastodon are one wide picture, not three identical ones.
  assert.deepEqual(
    postRenders(['x', 'bluesky', 'instagram', 'mastodon']).map((render) => [
      render.target.id,
      render.channels,
    ]),
    [
      ['x-post', ['x', 'bluesky', 'mastodon']],
      ['instagram-square', ['instagram']],
    ]
  )
  // One platform needs no second render, so the dialog offers no choice.
  assert.equal(postRenders(['x']).length, 1)
  assert.deepEqual(postRenders([]), [])
})

test('a platform drawn at its own size posts that picture, not the body’s', () => {
  const square = draftAssetNode({
    id: '0f1e2d3c-4b5a-4968-8778-66554433aaaa',
    mediaType: 'image/jpeg',
  })
  const body = screenshotPostBody({ caption: 'For X', media })
  const versions = screenshotPostVersions({
    body,
    channelText: { instagram: 'For Instagram', linkedin: 'For LinkedIn' },
    media: { instagram: square },
  })!
  platformVersionsSchema.parse(versions)

  // Instagram swaps the body's picture for its own and keeps its caption.
  const instagram = versionFor(versions, 'instagram')
  const pictures = instagram.body!.filter((node) => node.type === 'img')
  assert.equal(pictures.length, 1)
  assert.equal((pictures[0] as { assetId?: string }).assetId, square.assetId)
  assert.match(JSON.stringify(instagram.body), /For Instagram/)

  // LinkedIn was drawn no picture of its own, so it keeps the body's.
  const linkedin = versionFor(versions, 'linkedin')
  assert.equal(
    (linkedin.body!.find((node) => node.type === 'img') as { assetId?: string }).assetId,
    assetId
  )
  // The body itself is untouched, and X still reads it.
  assert.equal(bodyFor(body, versions, 'x'), body)
})

test('a picture for a platform with no version of its own changes nothing', () => {
  const square = draftAssetNode({
    id: '0f1e2d3c-4b5a-4968-8778-66554433bbbb',
    mediaType: 'image/jpeg',
  })
  const versions = screenshotPostVersions({
    body: screenshotPostBody({ caption: 'For X', media }),
    channelText: { linkedin: 'For LinkedIn' },
  })!
  assert.deepEqual(withPlatformMedia(versions, { bluesky: square }), versions)
})

// A body gets new random post ids on every build, so a key derived from the
// built draft never matched on retry, and the backend made a second draft.
test('a retry of the same choices replays the same request', async () => {
  const { postHandoff } = await import('@/lib/editor/post-handoff')
  const session = postHandoff({} as Parameters<typeof postHandoff>[0])
  let builds = 0
  const build = () => {
    builds += 1
    return screenshotPostBody({ caption: 'Saved views have names now.', media })
  }
  const first = session.request(['draft', 'design', assetId, ['acct']], build)
  const retry = session.request(['draft', 'design', assetId, ['acct']], build)
  // The same built body, ids and all, under the same key: the backend's
  // content hash matches, so it returns the draft it already made.
  assert.equal(builds, 1)
  assert.equal(retry.key, first.key)
  assert.equal(JSON.stringify(retry.input), JSON.stringify(first.input))
  // A different choice is a different post.
  const other = session.request(['draft', 'design', assetId, ['acct', 'other']], build)
  assert.notEqual(other.key, first.key)
  assert.equal(builds, 2)
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

test('a release screenshot opens on the brand kit and returns to its release', () => {
  const releaseId = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d'
  const href = editorHref({ assetId, brandKitId: 'clkit0000000001' }, { releaseId })
  assert.equal(href, `/editor?asset=${assetId}&kit=clkit0000000001&fromRelease=${releaseId}`)
  const search = href.slice(href.indexOf('?'))
  assert.deepEqual(readEditorReturn(search), { releaseId })
  assert.equal(readEditorBrandKit(search), 'clkit0000000001')
  // A malformed release or kit is dropped, not trusted: both reach API calls.
  assert.deepEqual(readEditorReturn('?fromRelease=../../admin'), {})
  // So is an id the draft contract would refuse, which would block every draft.
  assert.deepEqual(readEditorReturn('?fromRelease=12345678-1234-1234-1234-123456789012'), {})
  assert.equal(readEditorBrandKit('?kit=<script>'), undefined)
  // No kit, no parameter.
  assert.equal(editorHref({ assetId, brandKitId: undefined }), `/editor?asset=${assetId}`)
})

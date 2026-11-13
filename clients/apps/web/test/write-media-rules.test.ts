import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clock,
  DESTINATION_MEDIA,
  mediaChanges,
  mediaProblems,
  type MediaFacts,
  shapeName,
} from '@/lib/write/media-rules'
import type { DraftChannel } from '@/lib/write/document'

const row = (
  mimeType: string,
  bytes: number,
  width = 0,
  height = 0,
  durationMs = 0
): MediaFacts => ({
  mimeType,
  bytes,
  ...(width ? { width, height } : {}),
  ...(durationMs ? { durationMs } : {}),
})
const photo = row('image/jpeg', 300_000, 1080, 1350)
const png = row('image/png', 300_000, 1080, 1080)
const gif = row('image/gif', 2_000_000, 480, 270)
const mp4 = row('video/mp4', 20_000_000, 1080, 1920, 30_000)
const mov = row('video/quicktime', 20_000_000, 1080, 1920, 30_000)
const webm = row('video/webm', 20_000_000)
const many = (item: MediaFacts, count: number) => Array.from({ length: count }, () => item)

// The same cases as TestDraftMediaFollowsEachDestination in Go: the composer
// and the backend refuse the same combinations with the same words.
const cases: [string, DraftChannel, MediaFacts[], string][] = [
  ['x four photos', 'x', many(photo, 4), ''],
  ['x five photos', 'x', many(photo, 5), 'up to 4 attachments'],
  ['x photo and video', 'x', [photo, mp4], 'on its own'],
  ['x gif alone', 'x', [gif], ''],
  ['x gif with photo', 'x', [gif, photo], 'on its own'],
  ['x quicktime', 'x', [mov], 'takes MP4 video'],
  ['linkedin twenty photos', 'linkedin', many(photo, 20), ''],
  ['linkedin photos and gif', 'linkedin', [photo, gif], ''],
  [
    'linkedin short video',
    'linkedin',
    [row('video/mp4', 1_000_000, 720, 720, 2_000)],
    'from 0:03 to 30:00',
  ],
  [
    'linkedin long video',
    'linkedin',
    [row('video/mp4', 1_000_000, 720, 720, 1_800_001)],
    'is 30:00',
  ],
  ['linkedin quicktime', 'linkedin', [mov], 'Export it as MP4'],
  ['linkedin pdf attachment', 'linkedin', [row('application/pdf', 1000)], 'document option'],
  ['instagram empty', 'instagram', [], 'needs at least one'],
  ['tiktok empty', 'tiktok', [], 'needs one video'],
  ['instagram png is converted', 'instagram', [png], ''],
  ['instagram gif', 'instagram', [gif], 'animation'],
  ['instagram narrow', 'instagram', [row('image/jpeg', 1000, 300, 300)], 'at least 320 pixels'],
  ['instagram tall', 'instagram', [row('image/jpeg', 1000, 1000, 2000)], 'Crop it'],
  ['instagram mixed carousel', 'instagram', [photo, mov, png], ''],
  ['instagram twenty-one', 'instagram', many(photo, 21), 'up to 20'],
  [
    'instagram short reel',
    'instagram',
    [row('video/mp4', 1000, 1080, 1920, 2_500)],
    'from 0:03 to 15:00',
  ],
  [
    'instagram large reel',
    'instagram',
    [row('video/mp4', 400_000_000, 1080, 1920, 30_000)],
    'up to 300 MB',
  ],
  ['threads mixed carousel', 'threads', [photo, mp4], ''],
  ['threads long video', 'threads', [row('video/mp4', 1000, 1080, 1920, 300_001)], 'up to 5:00'],
  ['threads webm', 'threads', [webm], 'MP4, MOV'],
  ['bluesky gif', 'bluesky', [gif], 'animation'],
  ['bluesky photo and video', 'bluesky', [photo, mp4], 'on its own'],
  ['mastodon webm without length', 'mastodon', [webm], ''],
  ['mastodon five photos', 'mastodon', many(photo, 5), 'up to 4'],
  ['mastodon large image', 'mastodon', [row('image/png', 17_000_000, 100, 100)], 'up to 16 MB'],
  ['mastodon audio', 'mastodon', [row('audio/mpeg', 1000)], "can't publish audio/mpeg"],
]

for (const [name, channel, media, refusal] of cases) {
  test(`media rules: ${name}`, () => {
    const problems = mediaProblems(channel, media)
    if (!refusal) assert.deepEqual(problems, [])
    else
      assert.match(problems.join(' '), new RegExp(refusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
}

test('an attachment known only by its kind is counted, not refused for its format', () => {
  assert.deepEqual(mediaProblems('linkedin', [{ mimeType: 'video/*' }]), [])
  assert.match(
    mediaProblems('x', [{ mimeType: 'image/*' }, { mimeType: 'video/*' }]).join(),
    /on its own/
  )
})

test('conversions that change the media are disclosed before scheduling', () => {
  assert.match(mediaChanges('instagram', [png]).join(), /transparent areas become white/)
  assert.deepEqual(mediaChanges('instagram', [photo]), [])
  assert.match(mediaChanges('threads', [row('image/webp', 10)]).join(), /PNG copy of WEBP/)
})

test('every destination names where its numbers come from and when they were read', () => {
  for (const rules of Object.values(DESTINATION_MEDIA)) {
    assert.ok(rules.docs.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(rules.verifiedOn))
  }
})

test('video destinations require exactly one MP4 and refuse photos', () => {
  for (const channel of ['tiktok', 'youtube'] as const) {
    assert.equal(mediaProblems(channel, []).length > 0, true)
    assert.equal(mediaProblems(channel, [{ mimeType: 'image/png' }]).length > 0, true)
    assert.equal(mediaProblems(channel, [{ mimeType: 'image/*' }]).length > 0, true)
    assert.equal(
      mediaProblems(channel, [{ mimeType: 'video/mp4', durationMs: 5000, bytes: 1000 }]).length,
      0
    )
    assert.equal(
      mediaProblems(channel, [{ mimeType: 'video/mp4' }, { mimeType: 'video/mp4' }]).length > 0,
      true
    )
  }
})

test('a pin is one image; a Facebook Page post is text, photos or one video', () => {
  assert.deepEqual(mediaProblems('pinterest', []), [
    'Pinterest needs an image. Add one to the post.',
  ])
  assert.deepEqual(mediaProblems('pinterest', [photo]), [])
  assert.match(mediaProblems('pinterest', [photo, png]).join(), /up to 1 attachment/)
  // A video pin needs a cover Shots does not send yet.
  assert.deepEqual(mediaProblems('pinterest', [mp4]), ["Pinterest doesn't take video here."])
  assert.deepEqual(mediaProblems('facebook', []), [])
  assert.deepEqual(mediaProblems('facebook', [photo, png]), [])
  assert.deepEqual(mediaProblems('facebook', [mp4]), [])
  assert.match(mediaProblems('facebook', [photo, mp4]).join(), /on its own/)
  // The adapter recognizes MP4 only.
  assert.match(mediaProblems('facebook', [mov]).join(), /takes MP4 video; attachment 1 is MOV/)
})

test('a Google Business post is text or one image; a Facebook story is one image or MP4', () => {
  assert.deepEqual(mediaProblems('gmb', []), [])
  assert.deepEqual(mediaProblems('gmb', [photo]), [])
  assert.match(mediaProblems('gmb', [photo, png]).join(), /up to 1 attachment/)
  assert.deepEqual(mediaProblems('gmb', [mp4]), ["Google Business doesn't take video here."])
  assert.deepEqual(mediaProblems('facebook', [mp4], 'story'), [])
  assert.match(mediaProblems('facebook', [], 'story').join(), /A Facebook story needs/)
  assert.match(mediaProblems('facebook', [photo, png], 'story').join(), /up to 1 attachment/)
  assert.match(mediaProblems('facebook', [mov], 'story').join(), /takes MP4 video/)
})

test('a picture is named by the platform shape it is within 3% of, else by its size', () => {
  assert.equal(shapeName(1080, 1920), '9:16')
  assert.equal(shapeName(1080, 1350), '4:5')
  assert.equal(shapeName(1000, 1020), '1:1')
  assert.equal(shapeName(1920, 1080), '16:9')
  assert.equal(shapeName(1000, 1040), '1000×1040')
  assert.equal(clock(65_600), '1:06')
  // Seconds round before minutes do: 59.6s is a minute.
  assert.equal(clock(59_600), '1:00')
})

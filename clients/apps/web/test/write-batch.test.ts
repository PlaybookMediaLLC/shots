import assert from 'node:assert/strict'
import test from 'node:test'
import type { BatchItem } from '@/lib/api/contracts/content-batches'
import {
  batchAudience,
  batchSummary,
  captionProblem,
  feedPublications,
  hourlyWindow,
  plainTextDraft,
  plannedText,
  itemAccounts,
  previewPublications,
  pendingAccounts,
  postOn,
  queueTimings,
  runOutcomes,
  shortWhen,
  readTiming,
  spreadHourOptions,
  spreadTimings,
  stagedBody,
  stagedChecks,
  stagedVersions,
} from '@/lib/write/batch'

const item = (overrides: Partial<BatchItem> = {}): BatchItem => ({
  caption: 'Caption',
  channelConnectionIds: ['ig', 'li'],
  draft: null,
  draftId: null,
  id: 'item',
  importKey: 'item-import-key-0001',
  media: [
    {
      assetId: 'a',
      bytes: 1000,
      durationMs: null,
      height: 2000,
      mediaType: 'image/png',
      status: 'UPLOADED',
      width: 1000,
    },
  ],
  position: 0,
  posts: [],
  timing: {},
  ...overrides,
})
/** A post the scheduler made for an item on one account. */
const scheduledPost = (id: string, account: string, status: string, createdAt: string) => ({
  automations: [],
  caption: 'c',
  channelConnectionId: account,
  createdAt,
  failureCode: null,
  id,
  metrics: null,
  metricsAt: null,
  naturalOffsetSeconds: null,
  platform: 'x',
  publishedAt: null,
  replies: 0,
  scheduleMode: null,
  scheduleTimeZone: null,
  scheduledFor: createdAt,
  slotAt: null,
  socialSetId: null,
  status,
  threadProgress: { posted: 0, total: 0 },
  url: null,
})

const accounts = [
  { channel: 'instagram' as const, id: 'ig', name: 'Instagram' },
  { channel: 'linkedin' as const, id: 'li', name: 'LinkedIn' },
  { channel: 'x' as const, id: 'x', name: 'X' },
]

test('each chosen account is checked apart, with what Shots would change', () => {
  const checks = stagedChecks(item(), accounts)
  assert.deepEqual([...checks.keys()], ['ig', 'li'])
  assert.match(checks.get('ig')!.problems.join(), /4:5 portrait/)
  assert.match(checks.get('ig')!.changes.join(), /JPEG only/)
  assert.deepEqual(checks.get('li')!.problems, [])
  const uploading = item({
    media: [
      { fileName: 'a.png', bytes: 3, durationMs: null, height: null, width: null, status: 'local' },
    ],
  })
  assert.match(stagedChecks(uploading, accounts).get('li')!.problems.join(), /Finish uploading/)
  const pdf = { ...item().media[0], mediaType: 'application/pdf', width: null, height: null }
  const deck = stagedChecks(item({ media: [pdf] }), accounts)
  assert.deepEqual(deck.get('li'), { changes: [], problems: [] })
  assert.match(deck.get('ig')!.problems.join(), /Only LinkedIn posts a PDF/)
  const mixed = stagedChecks(item({ media: [pdf, item().media[0]] }), accounts)
  assert.match(mixed.get('li')!.problems.join(), /goes alone/)
})

test("an X video longer than the account's verified length is refused in Go's words", () => {
  const video = (durationMs: number) =>
    item({
      channelConnectionIds: ['x'],
      media: [
        { ...item().media[0], mediaType: 'video/mp4', durationMs, width: 1920, height: 1080 },
      ],
    })
  const standard = [{ ...accounts[2], xVideoMaxSeconds: 1200 }]
  assert.deepEqual(stagedChecks(video(600_000), standard).get('x')!.problems, [])
  assert.deepEqual(stagedChecks(video(1_200_000), standard).get('x')!.problems, [])
  assert.deepEqual(stagedChecks(video(1_200_999), standard).get('x')!.problems, [
    'This X account takes videos up to 20 minutes; this one is 20:00. Trim it before scheduling.',
  ])
  // Premium length passes; the unverified case is refused by the publication check.
  assert.deepEqual(
    stagedChecks(video(3_600_000), [{ ...accounts[2], xVideoMaxSeconds: 7500 }]).get('x')!.problems,
    []
  )
})

test('a local time is read in its own zone, refusing skipped and unchosen repeated times', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  const exact = readTiming(
    { mode: 'time', localTime: '2026-11-03T09:30', timeZone: 'Europe/Paris' },
    now
  )
  assert.equal(exact.kind === 'at' && exact.at.toISOString(), '2026-11-03T08:30:00.000Z')
  assert.match(
    JSON.stringify(
      readTiming({ mode: 'time', localTime: '2026-03-08T02:30', timeZone: 'America/New_York' }, now)
    ),
    /clocks skip it/
  )
  const repeated = {
    mode: 'time' as const,
    localTime: '2026-11-01T01:30',
    timeZone: 'America/New_York',
  }
  assert.match(JSON.stringify(readTiming(repeated, now)), /happens twice/)
  const later = readTiming({ ...repeated, disambiguation: 'later' }, now)
  assert.equal(later.kind === 'at' && later.at.toISOString(), '2026-11-01T06:30:00.000Z')
  assert.equal(readTiming({}, now).kind, 'unset')
  assert.match(JSON.stringify(readTiming({ mode: 'queue' }, now)), /Preview the queue/)
})

test('previewed times become timings that keep the zone or the expected slot', () => {
  assert.deepEqual(spreadTimings(['2026-11-03T08:30:00Z'], 'Europe/Paris'), [
    { mode: 'time', localTime: '2026-11-03T09:30', timeZone: 'Europe/Paris' },
  ])
  assert.deepEqual(queueTimings(['2026-11-03T08:30:00Z']), [
    { mode: 'queue', expectedQueueSlot: '2026-11-03T08:30:00Z' },
  ])
})

test('a corrected item resubmits only accounts without a live post, beside the ones queued', () => {
  const scheduled = item({
    posts: [
      scheduledPost('1', 'ig', 'SCHEDULED', '2026-01-01T00:00:00Z'),
      scheduledPost('2', 'li', 'FAILED', '2026-01-01T00:00:00Z'),
      scheduledPost('3', 'x', 'UNKNOWN_DELIVERY', '2026-01-01T00:00:00Z'),
    ] as BatchItem['posts'],
  })
  assert.deepEqual(pendingAccounts(scheduled, ['ig', 'li', 'x']), { add: true, remaining: ['li'] })
  assert.equal(postOn(scheduled, 'li')?.status, 'FAILED')
  assert.deepEqual(pendingAccounts(item(), ['ig']), { add: false, remaining: ['ig'] })
})

test("scheduling some accounts keeps the batch's other accounts to check and send", () => {
  const draft = { channelConnectionIds: ['ig'] } as BatchItem['draft']
  assert.deepEqual(itemAccounts(item({ draft, draftId: 'd' })), ['ig', 'li'])
  const widened = { channelConnectionIds: ['ig', 'x'] } as BatchItem['draft']
  assert.deepEqual(itemAccounts(item({ draft: widened, draftId: 'd' })), ['ig', 'li', 'x'])
})

test('the hours between posts keep a day inside 24 hours', () => {
  assert.deepEqual(spreadHourOptions(3), [1, 2, 3, 4, 6, 8])
  assert.deepEqual(spreadHourOptions(4), [1, 2, 3, 4, 6])
  assert.deepEqual(spreadHourOptions(24), [1])
})

test('a summary counts real calendar days, also across midnight', () => {
  const at = (localTime: string) =>
    item({ timing: { mode: 'time', localTime, timeZone: 'America/New_York' } })
  const now = new Date('2027-06-01T00:00:00Z')
  const summary = batchSummary(
    [
      at('2027-07-13T08:00'),
      at('2027-07-13T14:00'),
      at('2027-07-13T20:00'),
      at('2027-07-14T02:00'),
      item({ timing: {} }),
    ],
    'America/New_York',
    now
  )
  assert.equal(summary.calendarDays, 2)
  assert.equal(summary.posts, 5)
  assert.equal(summary.destinations, 10)
  assert.equal(summary.withoutTime, 1)
  assert.equal(summary.first?.toISOString(), '2027-07-13T12:00:00.000Z')
  assert.equal(summary.last?.toISOString(), '2027-07-14T06:00:00.000Z')
})

test('a caption must fit each chosen account by its own count', () => {
  const x = { channel: 'x', id: 'x', name: '@shots (x)' } as const
  const linkedin = { channel: 'linkedin', id: 'li', name: 'Shots (linkedin)' } as const
  const long = 'a'.repeat(281)
  assert.equal(captionProblem(long, [linkedin]), undefined)
  assert.match(captionProblem(long, [linkedin, x]) ?? '', /281 characters.*@shots \(x\) takes 280/)
  assert.equal(captionProblem(long, [{ ...x, captionLimit: 25_000 }]), undefined)
  // The longest alternative decides, even when a shorter one might be drawn.
  assert.match(captionProblem(`{short|${long}}`, [x]) ?? '', /281/)
  assert.equal(captionProblem('{short|fine}', [x]), undefined)
})

test('YouTube and TikTok options reach only the channels an item goes to', () => {
  const youtube = { madeForKids: false, privacy: 'unlisted', title: '' } as const
  const options = { youtube }
  const video = item({
    caption: 'Launch day\nSecond line',
    media: [
      {
        assetId: 'clip',
        durationMs: 8000,
        fileName: 'launch-teaser.mp4',
        height: 1920,
        status: 'UPLOADED',
        width: 1080,
      },
    ],
  })
  assert.equal(stagedVersions(video, ['linkedin'], options), undefined)
  const title = (versions: ReturnType<typeof stagedVersions>) =>
    versions?.versions.find((version) => version.channel === 'youtube')?.options?.youtube?.title
  assert.equal(title(stagedVersions(video, ['youtube'], options)), 'Launch day')
  assert.equal(
    title(stagedVersions({ ...video, caption: '' }, ['youtube'], options)),
    'launch-teaser'
  )
  assert.equal(
    title(stagedVersions(video, ['youtube'], { youtube: { ...youtube, title: 'Chosen' } })),
    'Chosen'
  )
})

test('a schedule run reads as an outcome per post, and never hides a failure', () => {
  assert.deepEqual(runOutcomes(null), {})
  assert.deepEqual(
    runOutcomes({
      items: [
        { itemId: 'a', status: 'DONE' },
        { itemId: 'b', status: 'PENDING' },
        { error: 'x: Too long.', itemId: 'c', status: 'FAILED' },
        { error: 'No confirmation came back.', itemId: 'd', status: 'UNCONFIRMED' },
        { itemId: 'e', status: 'FAILED' },
      ],
    }),
    {
      a: 'Scheduled',
      b: 'Waiting to be scheduled…',
      c: 'x: Too long.',
      d: 'No confirmation came back.',
      e: 'This post was not scheduled.',
    }
  )
})

test('an unrendered grid video says to render it, not that it has no media', () => {
  const concept = item({
    grid: {
      headline: 'Four tools',
      slots: [{ topic: 'a' }, { topic: 'b' }, { topic: 'c' }, { topic: 'd' }],
    },
    media: [],
  })
  const checks = stagedChecks(concept, [{ channel: 'instagram', id: 'ig', name: 'Shots' }])
  assert.deepEqual(checks.get('ig')?.problems, ['Render this video first.'])
})

test('the audience counts accounts, not one destination per post', () => {
  const xOnly = [1, 2, 3].map((n) => item({ channelConnectionIds: ['x'], id: `x${n}` }))
  assert.equal(batchAudience(xOnly, accounts), '3 posts to 1 X account')
  assert.equal(
    batchAudience([item(), item({ id: 'b' })], accounts),
    '2 posts to 2 accounts, 4 in all'
  )
  assert.equal(
    batchAudience(
      [item({ channelConnectionIds: ['ig'] }), item({ channelConnectionIds: ['li'] })],
      accounts
    ),
    '2 posts to 2 accounts'
  )
  assert.equal(
    batchAudience([item({ channelConnectionIds: [] })], accounts),
    '1 post, no account chosen'
  )
})

test('the hourly window is one post an hour, both ends included', () => {
  assert.equal(hourlyWindow('09:00', '17:00'), 9)
  assert.equal(hourlyWindow('09:30', '10:15'), 1)
  assert.equal(hourlyWindow('00:00', '23:59'), 24)
  assert.equal(hourlyWindow('09:00', '09:00'), null)
  assert.equal(hourlyWindow('17:00', '09:00'), null)
  assert.equal(hourlyWindow('09:00', '25:00'), null)
  assert.equal(hourlyWindow('', '09:00'), null)
})

test('only a plain single post can take new words from the batch', () => {
  const plain = [
    { children: [{ text: '' }], id: 'p_1', type: 'post_break' },
    { children: [{ text: 'One post.' }], type: 'p' },
    { children: [{ text: 'Its second paragraph.' }], id: 'b', type: 'p' },
  ]
  assert.equal(plainTextDraft(plain), true)
  // A thread, formatting, an image or a post's own settings would be lost.
  assert.equal(
    plainTextDraft([...plain, { children: [{ text: '' }], id: 'p_2', type: 'post_break' }]),
    false
  )
  assert.equal(
    plainTextDraft([plain[0], { children: [{ bold: true, text: 'Bold' }], type: 'p' }]),
    false
  )
  assert.equal(
    plainTextDraft([plain[0], { assetId: 'a', children: [{ text: '' }], type: 'img' }]),
    false
  )
  assert.equal(plainTextDraft([{ ...plain[0], poll: { options: [] } }, plain[1]]), false)
  assert.equal(plainTextDraft(null), false)
})

test('a staged body holds each post, then only the attachments already uploaded', () => {
  const body = stagedBody({
    caption: 'First post.\n---\nSecond post.',
    media: [
      {
        assetId: 'img',
        bytes: 1,
        durationMs: null,
        height: 1,
        mediaType: 'image/png',
        status: 'UPLOADED',
        width: 1,
      },
      {
        assetId: 'vid',
        bytes: 1,
        durationMs: 1000,
        height: 1,
        mediaType: 'video/mp4',
        status: 'UPLOADED',
        width: 1,
      },
      {
        assetId: 'doc',
        bytes: 1,
        durationMs: null,
        height: null,
        mediaType: 'application/pdf',
        status: 'UPLOADED',
        width: null,
      },
      {
        fileName: 'late.png',
        bytes: 1,
        durationMs: null,
        height: null,
        status: 'local',
        width: null,
      },
    ],
  })
  // Each post's words in order, then the uploaded files; the file still uploading is left out.
  assert.deepEqual(
    body.map((node) =>
      node.type === 'p' ? (node.children as { text: string }[])[0]!.text : node.type
    ),
    ['post_break', 'First post.', 'post_break', 'Second post.', 'img', 'video', 'file']
  )
  assert.deepEqual(
    body.filter((node) => 'assetId' in node).map((node) => node.assetId),
    ['img', 'vid', 'doc']
  )
  // An empty caption still makes one empty post, so the draft has a body.
  assert.equal(stagedBody({ caption: '', media: [] }).length, 2)
  // A thread longer than a draft holds is refused, as saving refuses it.
  const long = Array.from({ length: 26 }, (_, at) => `Part ${at + 1}`).join('\n---\n')
  assert.throws(() => stagedBody({ caption: long, media: [] }), /at most 25 posts/)
})

test('a preview builds each account publication as saving builds the draft', () => {
  const post = item({
    caption: 'Launch day.\n---\nThe details.',
    channelConnectionIds: ['x', 'li'],
  })
  const { cards, problem } = previewPublications(post, accounts, {})
  assert.equal(problem, undefined)
  assert.deepEqual(
    cards.map((card) => card.account.id),
    ['li', 'x']
  )
  const x = cards.find((card) => card.account.id === 'x')!.publication
  assert.equal(x.serialized.posts.length, 2)
  // The files follow the last part, as in the saved draft: on X they go out with the reply.
  assert.deepEqual(x.target.assetIds, [])
  assert.deepEqual(x.target.replies?.[0]?.assetIds, ['a'])
  // LinkedIn has no threads: the same words go out as one post.
  const linkedin = cards.find((card) => card.account.id === 'li')!.publication
  assert.equal(linkedin.serialized.posts.length, 1)
  assert.deepEqual(linkedin.target.assetIds, ['a'])
  // A caption a draft cannot hold is named, not thrown, so the page stays up.
  const long = Array.from({ length: 26 }, (_, at) => `Part ${at + 1}`).join('\n---\n')
  const refused = previewPublications(item({ caption: long }), accounts, {})
  assert.deepEqual(refused.cards, [])
  assert.match(refused.problem ?? '', /at most 25 posts/)
})

test('a post says when it is planned until the scheduler answers', () => {
  const at = '2099-11-13T09:30'
  const when = shortWhen(new Date(`${at}:00Z`), 'UTC')
  assert.equal(plannedText(item({ timing: {} }), 'UTC'), 'No time yet')
  assert.equal(
    plannedText(item({ timing: { mode: 'time', localTime: at, timeZone: 'UTC' } }), 'UTC'),
    `Planned for ${when}`
  )
  assert.equal(
    plannedText(item({ timing: { expectedQueueSlot: `${at}:00Z`, mode: 'queue' } }), 'UTC'),
    `Next queue slot: ${when}`
  )
  assert.match(plannedText(item({ timing: { mode: 'queue' } }), 'UTC'), /Preview the queue/)
  // Only a post on every account given makes the scheduler's answer the item's.
  const both = item({
    posts: [
      scheduledPost('1', 'ig', 'SCHEDULED', `${at}:00Z`),
      scheduledPost('2', 'li', 'SCHEDULED', `${at}:00Z`),
    ] as BatchItem['posts'],
  })
  assert.match(plannedText(both, 'UTC'), /^Scheduled · /)
  const one = item({ posts: both.posts.slice(0, 1), timing: {} })
  assert.equal(plannedText(one, 'UTC'), 'No time yet')
  assert.match(plannedText(one, 'UTC', ['ig']), /^Scheduled · /)
})

test('the feed shows the posts that go to its platform, in order, with their times', () => {
  const long = Array.from({ length: 26 }, (_, at) => `Part ${at + 1}`).join('\n---\n')
  const feed = feedPublications(
    [
      item({ caption: 'First', channelConnectionIds: ['x'], id: 'one' }),
      item({ caption: 'Second', channelConnectionIds: ['li'], id: 'two' }),
      item({ caption: long, channelConnectionIds: ['x'], id: 'three' }),
      item({
        caption: 'Fourth',
        channelConnectionIds: ['x', 'li'],
        id: 'four',
        posts: [scheduledPost('4', 'x', 'SCHEDULED', '2099-11-13T09:30:00Z')] as BatchItem['posts'],
      }),
    ],
    accounts,
    {},
    'x',
    'UTC'
  )
  assert.deepEqual(
    feed.posts.map((post) => [post.key, post.name, post.card.account.id, post.label]),
    [
      ['one', 'Post 1', 'x', 'No time yet'],
      ['four', 'Post 4', 'x', `Scheduled · ${shortWhen('2099-11-13T09:30:00Z', 'UTC')}`],
    ]
  )
  // The same post on LinkedIn has no post there yet: its feed keeps the proposal.
  assert.deepEqual(
    feedPublications(
      [
        item({
          channelConnectionIds: ['x', 'li'],
          id: 'four',
          posts: [
            scheduledPost('4', 'x', 'SCHEDULED', '2099-11-13T09:30:00Z'),
          ] as BatchItem['posts'],
        }),
      ],
      accounts,
      {},
      'linkedin',
      'UTC'
    ).posts.map((post) => post.label),
    ['No time yet']
  )
  // A post the preview cannot build is counted, not dropped unseen.
  assert.equal(feed.refused, 1)
})

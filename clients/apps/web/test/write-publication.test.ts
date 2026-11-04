import assert from 'node:assert/strict'
import test from 'node:test'
import { POST_BREAK, SOCIAL_MENTION } from '@/lib/content-drafts/serialize'
import type { PlateBody } from '@/lib/write/document'
import { buildPublication, type PublicationDraft } from '@/lib/write/publication'
import { forkVersion, readVersions, withOptions } from '@/lib/write/versions'
import { optionsSummary } from '@/components/write/composer/video-options'

const p = (text: string) => ({ children: [{ text }], type: 'p' })
const brk = (extra: object = {}) => ({ children: [{ text: '' }], type: POST_BREAK, ...extra })
const body: PlateBody = [
  brk({ id: 'a', replySettings: 'following', disclosures: { madeWithAi: true } }),
  p('First post'),
  brk({ id: 'b' }),
  p('Second post'),
  brk({ id: 'c' }),
  p('Follow for more'),
]
const draft = (extra: Partial<PublicationDraft> = {}): PublicationDraft => ({
  article: null,
  body,
  kind: 'standard',
  platformVersions: readVersions(undefined),
  target: null,
  ...extra,
})
const x = { channel: 'x' as const, connectionId: 'cx0000000001' }
const linkedin = { channel: 'linkedin' as const, connectionId: 'cl0000000001' }

test('an X thread sends each post with its own settings', () => {
  const { problems, target } = buildPublication(draft(), x)
  assert.deepEqual(problems, [])
  assert.equal(target.caption, 'First post')
  assert.deepEqual(target.options, { madeWithAi: true, replySettings: 'following' })
  assert.deepEqual(
    target.replies?.map((reply) => [reply.caption, reply.options]),
    [
      ['Second post', undefined],
      ['Follow for more', undefined],
    ]
  )
})

test('numbering is counted and applied for the X version only', () => {
  const versions = withOptions(readVersions(undefined), 'x', {
    numbering: { enabled: true, position: 'end', style: 'fraction' },
  })
  const numbered = buildPublication(draft({ platformVersions: versions }), x)
  assert.deepEqual(
    numbered.serialized.posts.map((post) => post.caption),
    ['First post 1/3', 'Second post 2/3', 'Follow for more 3/3']
  )
  assert.equal(numbered.serialized.posts[0].length, 'First post 1/3'.length)
  // LinkedIn joins the thread and takes no X settings.
  const joined = buildPublication(draft({ platformVersions: versions }), linkedin)
  assert.equal(joined.target.caption, 'First post\n\nSecond post\n\nFollow for more')
  assert.equal(joined.target.options, undefined)
  assert.equal(joined.target.replies, undefined)
})

test('a manual LinkedIn version publishes its own text and options', () => {
  let versions = forkVersion(readVersions(undefined), 'linkedin', body, 3, false)
  versions = {
    ...versions,
    versions: versions.versions.map((version) => ({
      ...version,
      body: [brk({ id: 'l' }), p('LinkedIn words')],
      options: { firstComment: 'Link in comments', visibility: 'CONNECTIONS' as const },
    })),
  }
  const { target } = buildPublication(draft({ platformVersions: versions }), linkedin)
  assert.equal(target.caption, 'LinkedIn words')
  assert.deepEqual(target.options, { firstComment: 'Link in comments', visibility: 'CONNECTIONS' })
  // X still follows the primary.
  assert.equal(
    buildPublication(draft({ platformVersions: versions }), x).target.caption,
    'First post'
  )
})

test('polls follow each platform’s rules', () => {
  const poll = (extra: object) => [
    brk({ id: 'a', poll: { durationMinutes: 1440, options: ['Yes', 'No'], ...extra } }),
    p('Ship it?'),
  ]
  const ok = buildPublication(draft({ body: poll({ question: 'Ship it?' }) }), linkedin)
  assert.deepEqual(ok.problems, [])
  assert.deepEqual(ok.target.options, { pollQuestion: 'Ship it?' })
  const noQuestion = buildPublication(draft({ body: poll({}) }), linkedin)
  assert.ok(noQuestion.problems.includes('Ask the poll question.'))
  const xPoll = buildPublication(draft({ body: poll({}) }), x)
  assert.deepEqual(xPoll.problems, [])
  assert.deepEqual(xPoll.target.poll, { durationMinutes: 1440, options: ['Yes', 'No'] })
  assert.deepEqual(buildPublication(draft({ body: poll({ durationMinutes: 6 }) }), x).problems, [])
  const longOption = buildPublication(draft({ body: poll({ options: ['a'.repeat(26), 'b'] }) }), x)
  assert.ok(longOption.problems.some((problem) => problem.includes('25 characters')))
  const withMedia = buildPublication(
    draft({
      body: [
        ...poll({ question: 'Q?' }),
        { assetId: 'cimage000001', children: [{ text: '' }], type: 'img' },
      ],
    }),
    linkedin
  )
  assert.ok(withMedia.problems.some((problem) => problem.includes('cannot have media')))
})

test('an X poll on a later post survives serialization with its own limits', () => {
  const body = [
    brk({ id: 'a' }),
    p('Introduction'),
    brk({ id: 'b', poll: { durationMinutes: 6, options: ['Yes', 'No'] } }),
    p('Ship it?'),
  ]
  const result = buildPublication(draft({ body }), x)
  assert.deepEqual(result.problems, [])
  assert.equal(result.target.poll, undefined)
  assert.deepEqual(result.target.replies?.[0].poll, { durationMinutes: 6, options: ['Yes', 'No'] })
  const invalid = buildPublication(
    draft({ body: [...body, { type: 'img', assetId: 'cimage000001', children: [{ text: '' }] }] }),
    x
  )
  assert.ok(
    invalid.problems.some((problem) => problem.startsWith('Post 2:') && problem.includes('media'))
  )
})

test('LinkedIn rejects invalid poll durations, raw length overflow and reshares before scheduling', () => {
  const content = (extra: object = {}) => [
    brk({
      poll: { question: 'Ship it?', durationMinutes: 1440, options: ['Yes', 'No'], ...extra },
    }),
    p('Release poll'),
  ]
  for (const durationMinutes of [1440, 4320, 10080, 20160]) {
    assert.deepEqual(
      buildPublication(draft({ body: content({ durationMinutes }) }), linkedin).problems,
      []
    )
  }
  for (const extra of [
    { durationMinutes: 5 },
    { durationMinutes: 1441 },
    { options: ['Only one'] },
    { question: ` ${'界'.repeat(140)} ` },
    { options: [` ${'界'.repeat(30)} `, 'No'] },
    { multiple: true },
  ]) {
    assert.ok(buildPublication(draft({ body: content(extra) }), linkedin).problems.length > 0)
  }
  assert.deepEqual(
    buildPublication(draft({ body: content({ question: '界'.repeat(140) }) }), linkedin).problems,
    []
  )
  assert.ok(
    buildPublication(
      draft({
        kind: 'quote',
        body: content(),
        target: {
          platform: 'linkedin',
          remoteId: 'urn:li:share:123456789',
          url: 'https://www.linkedin.com/feed/update/urn:li:share:123456789/',
        },
      }),
      linkedin
    ).problems.includes('A LinkedIn reshare cannot contain a poll.')
  )
})

test('kinds carry their target; Articles need verified access and a title', () => {
  const reply = buildPublication(
    draft({
      kind: 'reply',
      target: { platform: 'x', remoteId: '123', url: 'https://x.com/a/status/123' },
    }),
    x
  )
  assert.equal(reply.target.replyTo, '123')
  const quote = buildPublication(
    draft({
      kind: 'quote',
      target: { platform: 'x', remoteId: '9', url: 'https://x.com/a/status/9' },
    }),
    x
  )
  assert.equal(quote.target.options?.quoteRemoteId, '9')
  assert.ok(quote.problems.some((problem) => problem.includes('Enterprise API')))
  const finisher = buildPublication(
    draft({ body: [p('Root'), brk({ quoteFirstPost: true }), p('End')] }),
    x
  )
  assert.ok(finisher.problems.some((problem) => problem.includes('Enterprise API')))
  const standard = buildPublication(draft({ article: { title: 'Why' }, kind: 'article' }), x)
  assert.ok(standard.problems.some((problem) => problem.includes('Reconnect X')))
  const premium = buildPublication(
    draft({ article: { title: '' }, kind: 'article', body: [p('Article body')] }),
    {
      ...x,
      standing: { maxWeightedCharacters: 25_000, articles: true },
    }
  )
  assert.deepEqual(premium.problems, ['Give the article a title.'])
})

test('verified capabilities set the account text limit independently of Articles', () => {
  const long = draft({ body: [brk({ id: 'a' }), p('a'.repeat(400))] })
  assert.ok(buildPublication(long, x).problems.some((problem) => problem.includes('400 of 280')))
  assert.deepEqual(
    buildPublication(long, { ...x, standing: { maxWeightedCharacters: 25_000, articles: true } })
      .problems,
    []
  )
  const basic = { ...x, standing: { maxWeightedCharacters: 25_000 as const, articles: false } }
  assert.deepEqual(buildPublication(long, basic).problems, [])
  const article = draft({ body: [p('Article')], kind: 'article', article: { title: 'Why' } })
  assert.ok(
    buildPublication(article, basic).problems.some((problem) =>
      problem.includes('eligible account')
    )
  )
  assert.ok(
    buildPublication(article, { ...x, standing: { maxWeightedCharacters: 25_000 } }).problems.some(
      (problem) => problem.includes('Reconnect X')
    )
  )
})

test('mentions serialize the way each platform reads them', () => {
  const mention = {
    children: [{ text: '' }],
    handle: '',
    label: 'Acme Corp',
    platform: 'linkedin',
    providerId: 'urn:li:organization:42',
    type: SOCIAL_MENTION,
  }
  const mentioned = draft({
    body: [
      brk({ id: 'a' }),
      { children: [{ text: 'Thanks ' }, mention, { text: '!' }], type: 'p' },
    ],
  })
  assert.equal(
    buildPublication(mentioned, linkedin).target.caption,
    'Thanks @[Acme Corp](urn:li:organization:42)!'
  )
  assert.equal(buildPublication(mentioned, x).target.caption, 'Thanks Acme Corp!')
})

test('Mastodon polls use the connected server limits and preserve multiple choice independently of X', () => {
  const poll = { durationMinutes: 6, multiple: true, options: ['A', 'B', 'C', 'D', 'E'] }
  const content = draft({ body: [brk({ poll }), p('Choose your favorites')] })
  const account = {
    channel: 'mastodon' as const,
    connectionId: 'cm000000001',
    standing: {
      pollLimits: {
        maxOptions: 6,
        maxOptionCharacters: 80,
        minDurationSeconds: 300,
        maxDurationSeconds: 604800,
      },
    },
  }
  const built = buildPublication(content, account)
  assert.deepEqual(built.problems, [])
  assert.equal(built.target.poll?.multiple, true)
  assert.equal(built.target.poll?.durationMinutes, 6)
  assert.equal(built.target.poll?.options.length, 5)
  assert.ok(
    buildPublication(content, { ...account, standing: undefined }).problems.some((text) =>
      text.includes('verify this server')
    )
  )
  const xVersion = buildPublication(content, x)
  assert.ok(xVersion.problems.some((text) => text.includes('2 to 4')))
  assert.ok(xVersion.problems.some((text) => text.includes('Multiple-choice')))
})

test('Bluesky quotes retain native post references and finishers wait for the root', () => {
  const uri = 'at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/source'
  const result = buildPublication(
    draft({
      kind: 'quote',
      body: [p('My take'), brk({ quoteFirstPost: true }), p('Finisher')],
      target: {
        platform: 'bluesky',
        remoteId: uri,
        url: 'https://bsky.app/profile/did:plc:abcdefghijklmnopqrstuvwx/post/source',
      },
    }),
    { channel: 'bluesky', connectionId: 'cb0000000001' }
  )
  assert.deepEqual(result.problems, [])
  assert.equal(result.target.options?.quoteRemoteId, uri)
  assert.equal(result.target.replies?.[0].options?.quoteFirstPost, true)
})

test('Threads polls use native single-choice text-only rules', () => {
  const account = { channel: 'threads' as const, connectionId: 'ct0000000001' }
  const post = (changes: object = {}) =>
    draft({
      body: [
        brk({ poll: { options: ['Yes', 'No'], durationMinutes: 0, ...changes } }),
        p('Choose'),
      ],
    })
  const good = buildPublication(post(), account)
  assert.deepEqual(good.problems, [])
  assert.deepEqual(good.target.poll, { options: ['Yes', 'No'], durationMinutes: 0 })
  for (const changes of [
    { durationMinutes: 60 },
    { multiple: true },
    { options: ['x'.repeat(26), 'No'] },
    { question: 'Separate question' },
  ])
    assert.ok(buildPublication(post(changes), account).problems.length > 0)
  const withMedia = post()
  withMedia.body.push({ type: 'img', assetId: 'cimage000001', children: [{ text: '' }] })
  assert.ok(
    buildPublication(withMedia, account).problems.some((problem) => problem.includes('media'))
  )
})

test('link preview removal is persisted and cannot be silently ignored by a provider', () => {
  const card = { url: 'https://example.com/story', title: 'Story', removed: true }
  let versions = withOptions(readVersions(undefined), 'bluesky', { linkPreviews: [card] })
  const value = draft({ body: [p('Read https://example.com/story')], platformVersions: versions })
  assert.equal(
    buildPublication(value, { channel: 'bluesky', connectionId: 'cb0000000001' }).target.options
      ?.linkPreview?.removed,
    true
  )
  versions = withOptions(versions, 'x', { linkPreviews: [card] })
  assert.ok(
    buildPublication({ ...value, platformVersions: versions }, x).problems.some((problem) =>
      problem.includes('preview removal')
    )
  )
  const unrelated = draft({ body: [p('A different post')], platformVersions: versions })
  assert.equal(
    buildPublication(unrelated, { channel: 'bluesky', connectionId: 'cb0000000001' }).target.options
      ?.linkPreview,
    undefined
  )
})

test('Mastodon quotes require a verified server and quote lookup scopes', () => {
  const value = draft({
    kind: 'quote',
    body: [p('Commentary')],
    target: {
      platform: 'mastodon',
      remoteId: 'https://source.social/@person/123',
      url: 'https://source.social/@person/123',
    },
  })
  const account = { channel: 'mastodon' as const, connectionId: 'cm0000000001' }
  assert.ok(
    buildPublication(value, account).problems.some((problem) => problem.includes('Reconnect'))
  )
  const allowed = buildPublication(value, { ...account, standing: { mastodonQuotes: true } })
  assert.deepEqual(allowed.problems, [])
  assert.equal(allowed.target.options?.quoteRemoteId, 'https://source.social/@person/123')
})

test('TF-075 numbering follows edits on every thread platform without changing authored content', () => {
  for (const channel of ['x', 'threads', 'bluesky', 'mastodon'] as const) {
    const versions = withOptions(readVersions(undefined), channel, {
      numbering: { enabled: true, position: 'start', style: 'fraction' },
    })
    const authored = [brk({ id: 'c' }), p('Moved first'), brk({ id: 'a' }), p('Moved last')]
    const snapshot = JSON.stringify(authored)
    const input = draft({ body: authored, platformVersions: versions })
    const account = { channel, connectionId: 'account' }
    const first = buildPublication(input, account)
    assert.equal(first.target.caption, '1/2 Moved first')
    assert.equal(first.target.replies?.[0].caption, '2/2 Moved last')
    assert.deepEqual(buildPublication(input, account).target, first.target)
    assert.equal(JSON.stringify(authored), snapshot)
    const shortened = buildPublication({ ...input, body: authored.slice(0, 2) }, account)
    assert.equal(shortened.target.caption, 'Moved first')
  }
})

test('LinkedIn people and punctuated names keep native identities and reject malformed IDs', () => {
  const body = (providerId: string, label: string) => [
    brk({ id: 'a' }),
    {
      type: 'p',
      children: [
        {
          type: SOCIAL_MENTION,
          platform: 'linkedin',
          kind: 'person',
          providerId,
          label,
          children: [{ text: '' }],
        },
      ],
    },
  ]
  const person = draft({ body: body('urn:li:person:abc_123', 'Anne (AJ) Doe') })
  assert.equal(
    buildPublication(person, linkedin).target.caption,
    String.raw`@[Anne \(AJ\) Doe](urn:li:person:abc_123)`
  )
  assert.equal(buildPublication(person, x).target.caption, 'Anne (AJ) Doe')
  const invalid = draft({ body: body('urn:li:person:bad/path', 'Plain [name]') })
  assert.equal(buildPublication(invalid, linkedin).target.caption, 'Plain [name]')
})

test('X native quotes require the application grant without blocking draft creation', () => {
  const content = draft({
    kind: 'quote',
    target: { platform: 'x', remoteId: '123456789', url: 'https://x.com/i/status/123456789' },
    body: [brk({ id: 'root' }), p('A native quote')],
  })
  assert.ok(buildPublication(content, x).problems.some((message) => message.includes('Enterprise')))
  const eligible = buildPublication(content, { ...x, standing: { xQuotes: true } })
  assert.deepEqual(eligible.problems, [])
  assert.equal(eligible.target.options?.quoteRemoteId, '123456789')
  assert.equal(eligible.target.caption, 'A native quote')
})

test('community broadcast explicitly preserves both choices on the root only', () => {
  for (const shareWithFollowers of [false, true]) {
    const versions = withOptions(readVersions(undefined), 'x', {
      community: { id: '42', shareWithFollowers },
    })
    const result = buildPublication(draft({ platformVersions: versions }), x)
    assert.deepEqual(result.problems, [])
    assert.equal(result.target.options?.communityId, '42')
    assert.equal(result.target.options?.shareWithFollowers, shareWithFollowers)
    assert.ok(
      result.target.replies?.every(
        (reply) => !reply.options?.communityId && !reply.options?.shareWithFollowers
      )
    )
  }
})

test('Mastodon polls require instance limits and preserve exact native choices', () => {
  const body = [
    brk({
      id: 'poll',
      poll: {
        durationMinutes: 6,
        multiple: true,
        options: [' A ', '界'.repeat(40), 'C', 'D', 'E'],
      },
    }),
    p('Choose'),
  ]
  const account = { channel: 'mastodon' as const, connectionId: 'cmastodon01' }
  assert.ok(buildPublication(draft({ body }), account).problems.length)
  const standing = {
    pollLimits: {
      maxOptions: 5,
      maxOptionCharacters: 40,
      minDurationSeconds: 300,
      maxDurationSeconds: 3600,
    },
  }
  const publication = buildPublication(draft({ body }), { ...account, standing })
  assert.deepEqual(publication.problems, [])
  assert.equal(publication.target.poll?.multiple, true)
  assert.equal(publication.target.poll?.options[0], ' A ')
  const stricter = { pollLimits: { ...standing.pollLimits, maxOptions: 4 } }
  assert.ok(
    buildPublication(draft({ body }), { ...account, standing: stricter }).problems.some((p) =>
      p.includes('2 to 4')
    )
  )
})

test('X polls accept any documented minute duration without trimming choices', () => {
  const body = [
    brk({ id: 'poll', poll: { durationMinutes: 6, options: [' A ', 'B'] } }),
    p('Choose'),
  ]
  const publication = buildPublication(draft({ body }), x)
  assert.deepEqual(publication.problems, [])
  assert.equal(publication.target.poll?.options[0], ' A ')
})

test('Threads polls use native options and provider-controlled duration', () => {
  const poll = { options: [' Choice ', 'Second'], durationMinutes: 0 }
  const result = buildPublication(draft({ body: [brk({ poll }), p('Choose?')] }), {
    channel: 'threads',
    connectionId: 'threads',
  })
  assert.deepEqual(result.problems, [])
  assert.deepEqual(result.target.poll, { options: poll.options, durationMinutes: 0 })
  const legacy = buildPublication(
    draft({ body: [brk({ poll: { ...poll, durationMinutes: 1440 } }), p('Choose?')] }),
    { channel: 'threads', connectionId: 'threads' }
  )
  assert.deepEqual(legacy.problems, [])
  assert.equal(legacy.target.poll?.durationMinutes, 0)
  const wrong = buildPublication(
    draft({ body: [brk({ poll: { ...poll, durationMinutes: 60 } }), p('Choose?')] }),
    { channel: 'threads', connectionId: 'threads' }
  )
  assert.ok(wrong.problems.some((message) => message.includes('poll lengths')))
})

test('native Bluesky and verified Mastodon quote finishers retain channel settings', () => {
  for (const channel of ['bluesky', 'mastodon'] as const) {
    const data = draft({ body: [p('Root'), brk({ quoteFirstPost: true }), p('Finisher')] })
    const result = buildPublication(data, {
      channel,
      connectionId: 'cquote001',
      standing: { mastodonQuotes: true },
    })
    assert.deepEqual(result.problems, [])
    assert.equal(result.target.replies?.[0].options?.quoteFirstPost, true)
    if (channel === 'mastodon')
      assert.match(
        buildPublication(data, { channel, connectionId: 'cquote001' }).problems.join(),
        /native quote/
      )
  }
})

test('X photo tags survive publication and require photos', () => {
  const result = buildPublication(draft({ body: [brk({ photoTagIds: ['123'] }), p('Caption')] }), x)
  assert.deepEqual(result.target.options?.photoTagIds, ['123'])
  assert.match(result.problems.join(), /attached photo/)
  const linkedinResult = buildPublication(
    draft({ body: [brk({ photoTagIds: ['123'] }), p('Caption')] }),
    linkedin
  )
  assert.equal(linkedinResult.target.options?.photoTagIds, undefined)
})

test('preview media kinds follow the selected channel version without borrowing primary attachments', () => {
  const primary = [p('Primary'), { type: 'img', assetId: 'cimage000001', children: [{ text: '' }] }]
  let versions = forkVersion(readVersions(undefined), 'linkedin', primary, 1, false)
  versions = {
    ...versions,
    versions: versions.versions.map((v) => ({
      ...v,
      body: [p('Manual'), { type: 'video', assetId: 'cvideo000001', children: [{ text: '' }] }],
    })),
  }
  assert.deepEqual(
    buildPublication(draft({ body: primary, platformVersions: versions }), x).mediaTypes,
    { cimage000001: 'image' }
  )
  assert.deepEqual(
    buildPublication(draft({ body: primary, platformVersions: versions }), linkedin).mediaTypes,
    { cvideo000001: 'video' }
  )
})

test('synced Bluesky and Instagram versions cannot silently discard a primary poll', () => {
  const source = draft({
    body: [brk({ poll: { options: ['A', 'B'], durationMinutes: 0 } }), p('Choose a direction')],
  })
  for (const channel of ['bluesky', 'instagram'] as const) {
    assert.ok(
      buildPublication(source, { channel, connectionId: 'cunsupported00001' }).problems.some(
        (problem) => problem.includes('cannot carry a poll')
      )
    )
  }
})

test('an uploaded file blocks scheduling unless it is the LinkedIn document', () => {
  const pdf = 'cpdf00000001'
  const filed = draft({
    body: [p('Deck'), { assetId: pdf, children: [{ text: '' }], name: 'deck.pdf', type: 'file' }],
  })
  assert.match(buildPublication(filed, linkedin).problems.join(), /uploaded file or audio/)
  const versions = withOptions(readVersions(undefined), 'linkedin', {
    document: { assetId: pdf, title: 'Deck' },
  })
  const document = draft({ ...filed, platformVersions: versions })
  assert.deepEqual(buildPublication(document, linkedin).problems, [])
  assert.match(buildPublication(document, x).problems.join(), /uploaded file or audio/)
})

test('video publication keeps explicit privacy and refuses missing choices', () => {
  const youtube = { title: 'Local canary', privacy: 'private' as const, madeForKids: false }
  const versions = withOptions(readVersions(undefined), 'youtube', { youtube })
  const result = buildPublication(
    draft({ body: [p('Video caption')], platformVersions: versions }),
    { channel: 'youtube', connectionId: 'cy0000000001' }
  )
  assert.deepEqual(result.target.options?.youtube, youtube)
  const missing = buildPublication(draft({ body: [p('Video caption')] }), {
    channel: 'youtube',
    connectionId: 'cy0000000001',
  })
  assert.ok(missing.problems.some((problem) => problem.includes('audience')))
  const unavailable = buildPublication(draft({ body: [p('Video caption')] }), {
    channel: 'tiktok',
    connectionId: 'ct0000000001',
  })
  assert.ok(unavailable.problems.some((problem) => problem.includes('permissions are unavailable')))
})

test('a platform chip names its options in words and flags a missing required choice', () => {
  assert.deepEqual(optionsSummary('tiktok', {}), { needsInput: true, text: 'Choose privacy' })
  const tiktok = {
    allowComments: true,
    allowDuet: false,
    allowStitch: false,
    brandOrganic: false,
    brandedContent: false,
    consent: false,
    madeWithAi: false,
    privacy: 'SELF_ONLY',
  } as const
  assert.deepEqual(optionsSummary('tiktok', { tiktok }), {
    needsInput: true,
    text: 'Only me · comments on · consent needed',
  })
  assert.deepEqual(optionsSummary('tiktok', { tiktok: { ...tiktok, consent: true } }), {
    needsInput: false,
    text: 'Only me · comments on',
  })
  assert.equal(optionsSummary('youtube', {}).needsInput, true)
  assert.deepEqual(optionsSummary('x', {}), { needsInput: false, text: '' })
  // TikTok privacy and consent are separate problems, each named.
  const missing = buildPublication(draft({ body: [p('Video caption')] }), {
    channel: 'tiktok',
    connectionId: 'ct0000000001',
  })
  assert.ok(missing.problems.some((problem) => problem.includes('who can see')))
  assert.ok(missing.problems.some((problem) => problem.includes('Confirm consent')))
})

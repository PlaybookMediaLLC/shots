import assert from 'node:assert/strict'
import test from 'node:test'
import {
  channelForPlatform,
  draftPlainText,
  renderableBlockCount,
  serializeDraft,
} from '@/lib/content-drafts/serialize'

const p = (...children: object[]) => ({ type: 'p', children })
const text = (value: string, marks: object = {}) => ({ text: value, ...marks })

test('Bluesky counts graphemes and rejects its independent byte limit', () => {
  const valid = serializeDraft([p(text('👍🏽'.repeat(300)))], 'bluesky')
  assert.equal(valid.length, 300)
  assert.deepEqual(valid.errors, [])
  const overBytes = serializeDraft([p(text('👩‍💻'.repeat(300)))], 'bluesky')
  assert.equal(overBytes.length, 300)
  assert.deepEqual(overBytes.errors, ["Post 1 exceeds Bluesky's 3,000-byte text limit."])
})

test('Bluesky blocks excess images without dropping the selected attachments', () => {
  const images = Array.from({ length: 5 }, (_, index) => ({
    type: 'img',
    assetId: `asset-${index}`,
    url: `/api/v1/assets/asset-${index}/content`,
    children: [text('')],
  }))
  const result = serializeDraft([p(text('Look')), ...images], 'bluesky')
  assert.equal(result.assetIds.length, 5)
  assert.deepEqual(result.degradations, [])
  assert.deepEqual(result.errors, [
    'Bluesky takes up to 4 attachments in one post; this one has 5. Remove some, or schedule them as separate posts.',
  ])
})

test('an open mention picker counts and preserves the text already typed', () => {
  const body = [
    p(text('Hello '), { type: 'mention_input', value: 'padding', children: [text('')] }),
  ]
  const result = serializeDraft(body, 'x')
  assert.equal(result.caption, 'Hello @padding')
  assert.equal(result.length, 14)
  assert.equal(draftPlainText(body), 'Hello @padding')
})

test('paragraphs, headings and soft breaks become plain text', () => {
  const result = serializeDraft(
    [
      { type: 'h1', children: [text('Launch day')] },
      p(text('Line one\nline two')),
      p(text('Second paragraph')),
    ],
    'linkedin'
  )
  assert.equal(result.caption, 'Launch day\n\nLine one\nline two\n\nSecond paragraph')
  assert.deepEqual(result.degradations, [])
  assert.deepEqual(result.errors, [])
})

test('indent lists keep their markers, numbering and nesting', () => {
  const item = (value: string, listStyleType: string, indent = 1, extra: object = {}) => ({
    type: 'p',
    listStyleType,
    indent,
    ...extra,
    children: [text(value)],
  })
  const result = serializeDraft(
    [
      p(text('Steps:')),
      item('Install', 'decimal'),
      item('Configure', 'decimal'),
      item('Detail', 'disc', 2),
      item('Ship', 'decimal'),
      item('Done', 'todo', 1, { checked: true }),
      p(text('After')),
    ],
    'linkedin'
  )
  assert.equal(
    result.caption,
    'Steps:\n\n1. Install\n2. Configure\n  - Detail\n3. Ship\n[x] Done\n\nAfter'
  )
})

test('links, mentions and hashtags become plain text', () => {
  const result = serializeDraft(
    [
      p(
        text('Read '),
        { type: 'a', url: 'https://shots.example/blog', children: [text('the post')] },
        text(' by '),
        { type: 'mention', value: 'ada', children: [text('')] },
        text(' '),
        { type: 'tag', value: 'launch', children: [text('')] },
        text(' '),
        { type: 'a', url: 'https://shots.example', children: [text('https://shots.example')] }
      ),
    ],
    'x'
  )
  assert.equal(
    result.caption,
    'Read the post (https://shots.example/blog) by @ada #launch https://shots.example'
  )
})

test('tables become aligned rows and are reported', () => {
  const cell = (value: string) => ({ type: 'td', children: [p(text(value))] })
  const result = serializeDraft(
    [
      {
        type: 'table',
        children: [
          { type: 'tr', children: [cell('Plan'), cell('Price')] },
          { type: 'tr', children: [cell('Pro'), cell('$29')] },
          { type: 'tr', children: [cell('Business'), cell('$99')] },
          { type: 'tr', children: [cell(''), cell('')] },
        ],
      },
    ],
    'linkedin'
  )
  assert.equal(result.caption, 'Plan     | Price\nPro      | $29\nBusiness | $99')
  assert.deepEqual(
    result.degradations.map((item) => item.kind),
    ['table']
  )
})

test('math is posted as its source and footnotes as numbered notes', () => {
  const result = serializeDraft(
    [
      p(
        text('Energy '),
        { type: 'inline_equation', texExpression: 'E=mc^2', children: [text('')] },
        text(' holds'),
        { type: 'footnoteReference', identifier: 'b', children: [text('')] },
        text(' everywhere'),
        { type: 'footnoteReference', identifier: 'a', children: [text('')] }
      ),
      { type: 'equation', texExpression: '\\int_0^1 x\\,dx', children: [text('')] },
      { type: 'footnoteDefinition', identifier: 'a', children: [p(text('Second note.'))] },
      { type: 'footnoteDefinition', identifier: 'b', children: [p(text('First note.'))] },
    ],
    'linkedin'
  )
  assert.equal(
    result.caption,
    'Energy E=mc^2 holds[1] everywhere[2]\n\n\\int_0^1 x\\,dx\n\n[1] First note.\n[2] Second note.'
  )
  assert.deepEqual(result.degradations.map((item) => item.kind).sort(), ['footnotes', 'math'])
})

test('unsupported marks are dropped and reported once', () => {
  const result = serializeDraft(
    [
      p(
        text('Big', { bold: true }),
        text(' and ', {}),
        text('loud', { italic: true, color: 'red' })
      ),
    ],
    'x'
  )
  assert.equal(result.caption, 'Big and loud')
  assert.deepEqual(result.degradations, [
    { kind: 'formatting', message: 'Bold, italic and other formatting are removed.' },
  ])
})

test('images become attachments; embeds are reported', () => {
  const result = serializeDraft(
    [
      p(text('Look')),
      {
        type: 'img',
        assetId: 'asset-1',
        url: '/api/v1/assets/asset-1/content',
        children: [text('')],
      },
      {
        type: 'img',
        assetId: 'asset-2',
        url: '/api/v1/assets/asset-2/content',
        children: [text('')],
      },
      { type: 'video', url: 'https://video.example/v', children: [text('')] },
    ],
    'instagram'
  )
  assert.equal(result.caption, 'Look')
  assert.deepEqual(result.assetIds, ['asset-1', 'asset-2'])
  assert.deepEqual(result.degradations.map((item) => item.kind).sort(), ['embed'])
  assert.deepEqual(result.errors, [])
})

test('images past the channel limit are reported, not dropped from the draft', () => {
  const images = Array.from({ length: 5 }, (_, index) => ({
    type: 'img',
    assetId: `asset-${index}`,
    url: `/api/v1/assets/asset-${index}/content`,
    children: [text('')],
  }))
  const x = serializeDraft([p(text('Look')), ...images], 'x')
  assert.equal(x.assetIds.length, 5)
  assert.deepEqual(x.degradations, [])
  assert.deepEqual(x.errors, [
    'X takes up to 4 attachments in one post; this one has 5. Remove some, or schedule them as separate posts.',
  ])
  assert.deepEqual(serializeDraft([p(text('Look')), ...images], 'linkedin').degradations, [])
})

test('an image inside a paragraph is attached too', () => {
  const result = serializeDraft(
    [p(text('Notes'), { type: 'img', assetId: 'asset-9', url: '/x', children: [text('')] })],
    'x'
  )
  assert.equal(result.caption, 'Notes')
  assert.deepEqual(result.assetIds, ['asset-9'])
})

test('channel limits and requirements block scheduling', () => {
  const long = serializeDraft([p(text('a'.repeat(281)))], 'x')
  assert.equal(long.length, 281)
  assert.equal(long.limit, 280)
  assert.match(long.errors[0], /281 of 280/)
  assert.deepEqual(serializeDraft([p(text('a'.repeat(281)))], 'linkedin').errors, [])
  assert.deepEqual(serializeDraft([p(text('No picture'))], 'instagram').errors, [
    'Instagram needs at least one image or video. Add one to the post.',
  ])
  assert.deepEqual(serializeDraft([], 'x').errors, ['Write something to post.'])
  const external = serializeDraft(
    [p(text('Hi')), { type: 'img', url: 'https://elsewhere.example/a.png', children: [text('')] }],
    'x'
  )
  assert.deepEqual(external.errors, ['Upload every image to the workspace before scheduling.'])
  // twitter-text weights one emoji sequence as two characters.
  assert.equal(serializeDraft([p(text('🚀'))], 'x').length, 2)
  assert.equal(serializeDraft([p(text('👨‍👩‍👧‍👦'))], 'x').length, 2)
  assert.equal(serializeDraft([p(text('🇫🇷🇺🇸'))], 'x').length, 4)
  assert.equal(serializeDraft([p(text('cafe\u0301'))], 'x').length, 4)
  assert.equal(serializeDraft([p(text('example.com'))], 'x').length, 23)
})

test('connection platforms map to draft channels', () => {
  assert.equal(channelForPlatform('instagram-standalone'), 'instagram')
  assert.equal(channelForPlatform('x'), 'x')
  assert.equal(channelForPlatform('tiktok'), 'tiktok')
  assert.equal(channelForPlatform('youtube'), 'youtube')
  assert.equal(channelForPlatform('linkedin-page'), 'linkedin')
  assert.equal(channelForPlatform('facebook'), 'facebook')
  assert.equal(channelForPlatform('pinterest'), 'pinterest')
  assert.equal(channelForPlatform('gmb'), 'gmb')
  assert.equal(draftPlainText([p(text('Hello'), text(' world', { bold: true }))]), 'Hello world')
})

test('rendered tables and math blocks post as images in body order', () => {
  const value = [
    p(text('Pricing')),
    { type: 'equation', id: 'eq', texExpression: 'E = mc^2', children: [text('')] },
    { type: 'img', assetId: 'photo', url: '/api/v1/assets/photo/content', children: [text('')] },
    {
      type: 'table',
      id: 'tbl',
      children: [{ type: 'tr', children: [{ type: 'td', children: [p(text('Plan'))] }] }],
    },
  ]
  assert.equal(renderableBlockCount(value), 2)
  const preview = serializeDraft(value, 'instagram', ['', ''])
  assert.equal(preview.caption, 'Pricing')
  assert.deepEqual(preview.assetIds, ['photo'])
  assert.deepEqual(preview.errors, [])
  assert.deepEqual(preview.degradations.map((item) => item.message).sort(), [
    'Math blocks are posted as images.',
    'Tables are posted as images.',
  ])
  const posted = serializeDraft(value, 'x', ['eq-png', 'tbl-png'])
  assert.deepEqual(posted.assetIds, ['eq-png', 'photo', 'tbl-png'])
  // A block that failed to render posts as text.
  const partly = serializeDraft(value, 'x', ['eq-png', null])
  assert.deepEqual(partly.assetIds, ['eq-png', 'photo'])
  assert.match(partly.caption, /Plan/)
  // Without rendered images, both stay text.
  assert.match(serializeDraft(value, 'x').caption, /E = mc\^2[\s\S]*Plan/)
})

test('a thread posts each post on X and one joined post elsewhere', () => {
  const image = (id: string) => ({
    type: 'img',
    assetId: id,
    url: `/api/v1/assets/${id}/content`,
    children: [text('')],
  })
  const brk = { type: 'post_break', children: [text('')] }
  const value = [
    p(text('First post')),
    image('a'),
    brk,
    p(text('Second post')),
    image('b'),
    brk,
    // An empty post (a break just added) posts nothing.
    p(text('')),
  ]
  const x = serializeDraft(value, 'x')
  assert.deepEqual(
    x.posts.map(({ assetIds, caption }) => ({ assetIds, caption })),
    [
      { assetIds: ['a'], caption: 'First post' },
      { assetIds: ['b'], caption: 'Second post' },
    ]
  )
  assert.deepEqual(x.degradations, [])
  const linkedin = serializeDraft(value, 'linkedin')
  assert.equal(linkedin.posts.length, 1)
  assert.equal(linkedin.posts[0].caption, 'First post\n\nSecond post')
  assert.deepEqual(linkedin.posts[0].assetIds, ['a', 'b'])
  assert.deepEqual(
    linkedin.degradations.map((item) => item.kind),
    ['thread']
  )
  // Each X post has its own limit.
  const long = serializeDraft([p(text('Short')), brk, p(text('y'.repeat(281)))], 'x')
  assert.deepEqual(long.errors, ['Post 2 is 281 of 280 characters: shorten it for X.'])
  assert.equal(long.length, 281)
})

test("a channel's own text replaces the body there and keeps the images", () => {
  const value = [
    p(text('Body', { bold: true })),
    { type: 'img', assetId: 'a', url: '/api/v1/assets/a/content', children: [text('')] },
  ]
  const x = serializeDraft(value, 'x', undefined, 'Short for X\n\n\nAnd a reply')
  assert.deepEqual(
    x.posts.map(({ assetIds, caption }) => ({ assetIds, caption })),
    [
      { assetIds: ['a'], caption: 'Short for X' },
      { assetIds: [], caption: 'And a reply' },
    ]
  )
  assert.deepEqual(x.degradations, [])
  const linkedin = serializeDraft(value, 'linkedin', undefined, 'Longer for LinkedIn')
  assert.equal(linkedin.caption, 'Longer for LinkedIn')
  assert.equal(serializeDraft(value, 'linkedin', undefined, '  ').caption, 'Body')
})

test('an uploaded video is the post media and goes alone', () => {
  const video = {
    type: 'video',
    assetId: 'v1',
    url: '/api/v1/assets/v1/content',
    children: [text('')],
  }
  const image = {
    type: 'img',
    assetId: 'i1',
    url: '/api/v1/assets/i1/content',
    children: [text('')],
  }
  const alone = serializeDraft([p(text('Watch')), video], 'linkedin')
  assert.deepEqual(alone.assetIds, ['v1'])
  assert.deepEqual(alone.errors, [])
  assert.deepEqual(alone.degradations, [])
  const mixed = serializeDraft([p(text('Watch')), video, image], 'x')
  assert.deepEqual(mixed.errors, [
    'X posts a video or GIF on its own. Move the other attachments to a separate post.',
  ])
  // Instagram and Threads carousels take photos and videos together.
  assert.deepEqual(serializeDraft([p(text('Watch')), video, image], 'threads').errors, [])
  // A video embedded by its link is still left out.
  const embed = serializeDraft(
    [p(text('Watch')), { type: 'video', url: 'https://video.example/v', children: [text('')] }],
    'x'
  )
  assert.deepEqual(embed.assetIds, [])
  assert.deepEqual(
    embed.degradations.map((item) => item.kind),
    ['embed']
  )
})

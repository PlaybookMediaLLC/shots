import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containFit,
  coverCrop,
  frameAlpha,
  frameSource,
  GRID_VIDEO,
  gridLayout,
  type GridRect,
  isRtl,
  OVERLAY,
  overlayBlock,
  SINGLE_FADE_IN_FRAMES,
  singleLayout,
  ugcTimeline,
  wrapLines,
} from '@/lib/write/grid-layout'

const inside = (inner: GridRect, outer: GridRect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

const overlaps = (a: GridRect, b: GridRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('the frame is an even 9:16 for H.264, six seconds at 30 fps', () => {
  assert.equal(GRID_VIDEO.width % 2, 0)
  assert.equal(GRID_VIDEO.height % 2, 0)
  assert.equal(GRID_VIDEO.width / GRID_VIDEO.height, 9 / 16)
  assert.equal(GRID_VIDEO.fps * GRID_VIDEO.seconds, 180)
})

test('everything stays on the panel and nothing overlaps', () => {
  const { cells, headline, panel } = gridLayout()
  assert.ok(panel.y > 0, 'bands above and below')
  const parts = [headline, ...cells.flatMap((cell) => [cell.label, cell.image])]
  for (const part of parts) assert.ok(inside(part, panel), JSON.stringify(part))
  for (const [index, part] of parts.entries())
    for (const other of parts.slice(index + 1))
      assert.ok(!overlaps(part, other), JSON.stringify([part, other]))
})

test('cells read left to right and top to bottom, at equal sizes', () => {
  const { cells } = gridLayout()
  assert.equal(cells.length, 4)
  assert.equal(cells[0]!.image.y, cells[1]!.image.y)
  assert.ok(cells[1]!.image.x > cells[0]!.image.x)
  assert.ok(cells[2]!.image.y > cells[0]!.image.y)
  assert.equal(cells[0]!.image.width, cells[3]!.image.width)
  assert.equal(cells[0]!.image.height, cells[3]!.image.height)
})

test('a cover crop fills the target from the middle without stretching', () => {
  assert.deepEqual(coverCrop({ height: 100, width: 400 }, { height: 100, width: 100 }), {
    height: 100,
    width: 100,
    x: 150,
    y: 0,
  })
  assert.deepEqual(coverCrop({ height: 400, width: 100 }, { height: 100, width: 100 }), {
    height: 100,
    width: 100,
    x: 0,
    y: 150,
  })
})

test('text wraps to its lines and ends with an ellipsis when it cannot fit', () => {
  const measure = (line: string) => line.length
  assert.deepEqual(wrapLines('one two three', 7, 2, measure), ['one two', 'three'])
  assert.deepEqual(wrapLines('one two three four', 7, 2, measure), ['one two', 'three…'])
  assert.deepEqual(wrapLines('  ', 7, 2, measure), [])
})

test('a word wider than a line breaks between characters, never inside one', () => {
  const measure = (line: string) => line.length
  // A long token, such as a URL, used to end its line with …; now it wraps.
  assert.deepEqual(wrapLines('incomprehensibly', 7, 2, measure), ['incompr', 'ehensi…'])
  // CJK has no spaces to break at.
  assert.deepEqual(wrapLines('四つの夕食が二十分でできる', 6, 3, measure), [
    '四つの夕食が',
    '二十分ででき',
    'る',
  ])
  // An emoji made of several code points stays whole.
  const graphemes = (line: string) =>
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].length
  const family = '👨‍👩‍👧'
  assert.deepEqual(wrapLines(family.repeat(3), 2, 2, graphemes), [family.repeat(2), family])
  assert.deepEqual(wrapLines(`${family}${family}${family} ok`, 2, 2, graphemes), [
    family.repeat(2),
    `${family}…`,
  ])
})

test('typed line breaks are kept and lines past the limit end in an ellipsis', () => {
  const measure = (line: string) => line.length
  assert.deepEqual(wrapLines('TECHNICAL PREVIEW\nBuilt-in template test', 20, 4, measure), [
    'TECHNICAL PREVIEW',
    'Built-in template',
    'test',
  ])
  assert.deepEqual(wrapLines('a b c d e f', 3, 2, measure), ['a b', 'c…'])
  assert.deepEqual(wrapLines('one\r\n\n two', 7, 3, measure), ['one', 'two'])
})

test('right-to-left lines are told apart by their first letter', () => {
  assert.ok(isRtl('مرحبا بالعالم'))
  assert.ok(isRtl('«שלום» עולם'))
  assert.ok(isRtl('2026 مرحبا'))
  assert.ok(!isRtl('Hello مرحبا'))
  assert.ok(!isRtl('四つの夕食'))
})

test('frames fade in and out, and the first frame is not black', () => {
  assert.ok(frameAlpha(0, 180) > 0)
  assert.equal(frameAlpha(90, 180), 1)
  assert.ok(frameAlpha(179, 180) < 1)
  assert.ok(frameAlpha(179, 180) > 0)
})

test('the fade-in starts nearly black and is fully visible after a second', () => {
  assert.ok(frameAlpha(0, 180, SINGLE_FADE_IN_FRAMES) > 0)
  assert.ok(frameAlpha(0, 180, SINGLE_FADE_IN_FRAMES) <= 0.1)
  assert.ok(frameAlpha(15, 180, SINGLE_FADE_IN_FRAMES) < 1)
  assert.equal(frameAlpha(SINGLE_FADE_IN_FRAMES, 180, SINGLE_FADE_IN_FRAMES), 1)
  assert.ok(frameAlpha(1, 180, SINGLE_FADE_IN_FRAMES) > frameAlpha(0, 180, SINGLE_FADE_IN_FRAMES))
})

test('a fade-in shows its headline above the image, or the image alone', () => {
  for (const hidden of [false, true]) {
    const { headline, image, panel } = singleLayout(hidden)
    assert.ok(inside(image, panel), JSON.stringify(image))
    assert.equal(headline === null, hidden)
    if (headline) {
      assert.ok(inside(headline, panel))
      assert.ok(!overlaps(headline, image))
    }
  }
  // Image only gives the image the headline's room.
  assert.ok(singleLayout(true).image.height > singleLayout(false).image.height)
})

test('a contained image is whole, centred and as large as fits', () => {
  const box = { height: 1000, width: 1000, x: 40, y: 400 }
  assert.deepEqual(containFit({ height: 400, width: 500 }, box), {
    height: 800,
    width: 1000,
    x: 40,
    y: 500,
  })
  assert.deepEqual(containFit({ height: 2000, width: 500 }, box), {
    height: 1000,
    width: 250,
    x: 415,
    y: 400,
  })
})

test('overlay text sits at the top, middle or bottom and stays in the frame', () => {
  const frame = { height: GRID_VIDEO.height, width: GRID_VIDEO.width, x: 0, y: 0 }
  for (const lines of [1, OVERLAY.maxLines]) {
    const top = overlayBlock(lines, 'top')
    const middle = overlayBlock(lines, 'middle')
    const bottom = overlayBlock(lines, 'bottom')
    for (const block of [top, middle, bottom])
      assert.ok(inside(block, frame), JSON.stringify(block))
    assert.ok(top.y <= middle.y && middle.y <= bottom.y)
    assert.equal(top.y, OVERLAY.inset)
    assert.equal(bottom.y + bottom.height, GRID_VIDEO.height - OVERLAY.inset)
    assert.equal(Math.round(middle.y + middle.height / 2), GRID_VIDEO.height / 2)
  }
})

test('a UGC video is its clip then its closing clip, at 30 fps', () => {
  // The analysis measured 153 frames for a 5.1-second template (ST-031).
  assert.deepEqual(ugcTimeline(5100), { clipFrames: 153, durationMs: 5100, frames: 153 })
  const timeline = ugcTimeline(5100, 3000)
  assert.deepEqual(timeline, { clipFrames: 153, durationMs: 8100, frames: 243 })
  assert.deepEqual(frameSource(0, timeline.clipFrames), { closing: false, seconds: 0 })
  assert.deepEqual(frameSource(153, timeline.clipFrames), { closing: true, seconds: 0 })
  assert.equal(frameSource(242, timeline.clipFrames).seconds, 89 / 30)
  // The 3 and 15 second ends of the closing clip's range.
  assert.equal(ugcTimeline(3000, 3000).frames, 180)
  assert.equal(ugcTimeline(60_000, 15_000).frames, 2250)
})

test('overlay text of every kind wraps within the overlay and its block stays in the frame', () => {
  // About as wide as the 64 px bold face: CJK and emoji take a full em, Latin and Arabic about half.
  const measure = (line: string) =>
    [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].reduce(
      (width, { segment }) =>
        width +
        (/[\p{Script=Han}\p{Script=Hiragana}\p{Extended_Pictographic}]/u.test(segment) ? 64 : 34),
      0
    )
  const frame = { height: GRID_VIDEO.height, width: GRID_VIDEO.width, x: 0, y: 0 }
  const texts = {
    arabic: 'هذا هو المخطط الذي كنت أبحث عنه طوال الأسبوع\nجربه اليوم',
    cjk: '四つの夕食が二十分でできる簡単な献立を毎週作っています',
    emoji: '👨‍👩‍👧 family plan 🗓️✨ '.repeat(5),
    long: 'a'.repeat(150),
    multiline: 'POV:\nyou finally\nfound a planner\nthat fits\nyour week',
  }
  for (const position of ['top', 'middle', 'bottom'] as const) {
    const width = overlayBlock(1, position).width - 10
    for (const [kind, text] of Object.entries(texts)) {
      const lines = wrapLines(text, width, OVERLAY.maxLines, measure)
      assert.ok(lines.length >= 1 && lines.length <= OVERLAY.maxLines, kind)
      for (const line of lines) assert.ok(measure(line) <= width, `${kind}: ${line}`)
      assert.ok(inside(overlayBlock(lines.length, position), frame), `${kind} at ${position}`)
      if (kind === 'arabic') assert.ok(lines.every(isRtl))
    }
  }
  // Typed line breaks survive the wrap.
  assert.deepEqual(
    wrapLines(texts.multiline, overlayBlock(1, 'top').width, OVERLAY.maxLines, measure),
    ['POV:', 'you finally', 'found a planner', 'that fits', 'your week']
  )
})

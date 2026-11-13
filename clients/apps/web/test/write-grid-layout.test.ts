import assert from 'node:assert/strict'
import test from 'node:test'
import {
  coverCrop,
  frameAlpha,
  GRID_VIDEO,
  gridLayout,
  type GridRect,
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

test('a crop focus places the shape along the side it does not fill', () => {
  // A square from a 400×100 landscape: at the start, the end, and a quarter in.
  assert.equal(
    coverCrop({ height: 100, width: 400 }, { height: 1, width: 1 }, { x: 0, y: 0.5 }).x,
    0
  )
  assert.equal(
    coverCrop({ height: 100, width: 400 }, { height: 1, width: 1 }, { x: 1, y: 0.5 }).x,
    300
  )
  assert.equal(
    coverCrop({ height: 100, width: 400 }, { height: 1, width: 1 }, { x: 0.25, y: 0.5 }).x,
    75
  )
  // A 9:16 story from a 1600×900 landscape keeps the full height.
  const story = coverCrop({ height: 900, width: 1600 }, { height: 16, width: 9 }, { x: 0.5, y: 0 })
  assert.deepEqual(
    { height: story.height, width: Math.round(story.width), x: Math.round(story.x), y: story.y },
    { height: 900, width: 506, x: 547, y: 0 }
  )
  // A square from a 100×400 portrait moves only up and down.
  const portrait = coverCrop({ height: 400, width: 100 }, { height: 1, width: 1 }, { x: 0.5, y: 1 })
  assert.deepEqual(portrait, { height: 100, width: 100, x: 0, y: 300 })
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
  assert.deepEqual(wrapLines('incomprehensibly', 7, 2, measure), ['incomp…'])
  assert.deepEqual(wrapLines('  ', 7, 2, measure), [])
})

test('frames fade in and out, and the first frame is not black', () => {
  assert.ok(frameAlpha(0, 180) > 0)
  assert.equal(frameAlpha(90, 180), 1)
  assert.ok(frameAlpha(179, 180) < 1)
  assert.ok(frameAlpha(179, 180) > 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assembleConcepts,
  fillEmptySlots,
  gridInputProblem,
  gridReady,
  missingImages,
  redrawConcept,
  withLastCell,
  withSlot,
} from '@/lib/write/grid-concepts'
import { GRID_PRESETS } from '@/lib/write/grid-presets'

const items = ['workspace', 'calendar', 'tracker', 'organizer', 'notebook']

/** A small repeatable generator, so assembly can be checked exactly. */
function seeded(seed = 1) {
  return () => {
    seed = (seed * 16807) % 2147483647
    return (seed - 1) / 2147483646
  }
}

test('input is checked in the order a person fills it in', () => {
  assert.match(gridInputProblem({ captions: [' '], items: [] }) ?? '', /at least one caption/)
  assert.match(gridInputProblem({ captions: ['A'], items: [] }) ?? '', /at least one content item/)
  assert.match(
    gridInputProblem({ captions: ['A'], items: ['a', 'A ', 'b', 'c', 'a'] }) ?? '',
    /at least 4 different/
  )
  assert.equal(gridInputProblem({ captions: ['A'], items: ['a', 'b', 'c', 'd'] }), null)
})

test('captions take turns, and each concept draws four different items', () => {
  const concepts = assembleConcepts({ captions: ['One', ' ', 'Two'], count: 3, items }, seeded())
  assert.deepEqual(
    concepts.map((concept) => concept.headline),
    ['One', 'Two', 'One']
  )
  for (const concept of concepts) {
    assert.equal(new Set(concept.slots.map((slot) => slot.topic)).size, 4)
    assert.ok(concept.slots.every((slot) => items.includes(slot.topic)))
  }
  assert.equal(
    new Set(concepts.map((concept) => concept.slots.map((slot) => slot.topic).join())).size,
    3
  )
})

test('readiness and the missing count follow the slots', () => {
  const [concept] = assembleConcepts({ captions: ['A'], count: 1, items }, seeded())
  assert.equal(gridReady(concept!), false)
  assert.equal(missingImages([concept!, concept!]), 8)
  const full = [0, 1, 2, 3].reduce(
    (grid, at) => withSlot(grid, at, { assetId: `i${at}` }),
    concept!
  )
  assert.equal(gridReady(full), true)
  assert.equal(missingImages([full, concept!]), 4)
})

test('bulk images fill empty slots in order and name what is left', () => {
  const concepts = assembleConcepts({ captions: ['A'], count: 2, items }, seeded())
  const started = [withSlot(concepts[0]!, 1, { assetId: 'kept' }), concepts[1]!]
  const few = fillEmptySlots(started, ['a', 'b', 'c', 'd'])
  assert.deepEqual(
    few.filled.map((grid) => grid.slots.map((slot) => slot.assetId)),
    [
      ['a', 'kept', 'b', 'c'],
      ['d', undefined, undefined, undefined],
    ]
  )
  assert.deepEqual(few.unused, [])
  const many = fillEmptySlots([concepts[1]!], ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(many.unused, ['e'])
})

test('the last cell setting writes only the bottom right, and blank keeps it', () => {
  const [concept] = assembleConcepts({ captions: ['A'], count: 1, items }, seeded())
  const topics = concept!.slots.map((slot) => slot.topic)
  const set = withLastCell(concept!, { topic: ' Follow us ', assetId: 'cta' })
  assert.deepEqual(
    set.slots.map((slot) => slot.topic),
    [...topics.slice(0, 3), 'Follow us']
  )
  assert.equal(set.slots[3]?.assetId, 'cta')
  assert.deepEqual(withLastCell(concept!, { topic: '  ' }), concept)
})

test('redrawing a concept draws other items, drops its images and keeps its music', () => {
  const concept = withSlot(
    {
      headline: 'Keep me',
      musicAssetId: 'music',
      slots: ['a', 'b', 'c', 'd'].map((topic) => ({ topic })),
    },
    0,
    { assetId: 'image' }
  )
  const redrawn = redrawConcept(concept, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'E '], seeded(3))
  assert.equal(redrawn.headline, 'Keep me')
  assert.equal(redrawn.musicAssetId, 'music')
  assert.equal(redrawn.slots.length, 4)
  assert.ok(redrawn.slots.every((slot) => !slot.assetId))
  assert.notEqual(redrawn.slots.map((slot) => slot.topic).join(), 'a,b,c,d')
  assert.equal(new Set(redrawn.slots.map((slot) => slot.topic.toLowerCase())).size, 4)
  // With only its own four items, it still changes their order.
  const same = redrawConcept(concept, [], seeded(5))
  assert.equal(new Set(same.slots.map((slot) => slot.topic)).size, 4)
  assert.notEqual(same.slots.map((slot) => slot.topic).join(), 'a,b,c,d')
})

test('every preset can make concepts as it stands', () => {
  for (const preset of GRID_PRESETS) {
    assert.equal(gridInputProblem(preset), null, preset.name)
    assert.ok(
      preset.captions.every((caption) => caption.length <= 60),
      preset.name
    )
  }
})

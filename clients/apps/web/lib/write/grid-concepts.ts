import type { BatchGrid } from '@/lib/api/contracts/content-batches'

/**
 * Grid video concepts, kept apart from the page so they can be tested: what a
 * set of captions and content items must hold, how they assemble into
 * concepts, and how images fill their slots.
 */

/** The cells of a grid video. */
export const GRID_SLOT_COUNT = 4

/** The cell a "last cell" setting writes: the grid's bottom right. */
export const GRID_LAST_SLOT = GRID_SLOT_COUNT - 1

/** The most concepts one run makes. */
export const GRID_MAX_CONCEPTS = 30

/** Lines without blanks or repeats; `Notes` and `notes` are one item. */
function cleaned(lines: readonly string[]) {
  const seen = new Map<string, string>()
  for (const line of lines) {
    const text = line.trim()
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text)
  }
  return [...seen.values()]
}

/** What to fix before concepts can be made, or null. */
export function gridInputProblem(input: { captions: string[]; items: string[] }) {
  if (!cleaned(input.captions).length) return 'Add at least one caption.'
  const items = cleaned(input.items)
  if (!items.length) return 'Add at least one content item.'
  if (items.length < GRID_SLOT_COUNT)
    return `Add at least ${GRID_SLOT_COUNT} different content items for the 2×2 grid.`
  return null
}

/** A random draw of `count` items, each one once. */
function draw(items: readonly string[], count: number, random: () => number) {
  const pool = [...items]
  for (let at = pool.length - 1; at > 0; at--) {
    const other = Math.floor(random() * (at + 1))
    ;[pool[at], pool[other]] = [pool[other]!, pool[at]!]
  }
  return pool.slice(0, count)
}

/**
 * Concepts from captions and content items: captions take turns, and each
 * concept draws four items in its own order. With few items concepts may
 * repeat, so a repeat is tried again a few times rather than promised away.
 */
export function assembleConcepts(
  input: { captions: string[]; count: number; items: string[] },
  random: () => number = Math.random
): BatchGrid[] {
  const captions = cleaned(input.captions)
  const items = cleaned(input.items)
  const seen = new Set<string>()
  return Array.from({ length: input.count }, (_, index) => {
    let topics = draw(items, GRID_SLOT_COUNT, random)
    for (let tries = 0; tries < 8 && seen.has(topics.join('\n')); tries++)
      topics = draw(items, GRID_SLOT_COUNT, random)
    seen.add(topics.join('\n'))
    return {
      headline: captions[index % captions.length]!,
      slots: topics.map((topic) => ({ topic })),
    }
  })
}

/** Whether every slot of a concept has its image. */
export const gridReady = (grid: BatchGrid) => grid.slots.every((slot) => slot.assetId)

/** How many images concepts still need. */
export const missingImages = (grids: readonly BatchGrid[]) =>
  grids.reduce((total, grid) => total + grid.slots.filter((slot) => !slot.assetId).length, 0)

/** A concept with one slot changed. */
export function withSlot(
  grid: BatchGrid,
  index: number,
  change: Partial<BatchGrid['slots'][number]>
): BatchGrid {
  return {
    ...grid,
    slots: grid.slots.map((slot, at) => (at === index ? { ...slot, ...change } : slot)),
  }
}

/**
 * Bulk images, in order, into the empty slots of each concept in order. Images
 * left over are returned and named; too few leave the last slots empty.
 */
export function fillEmptySlots<Image extends string>(
  grids: readonly BatchGrid[],
  images: readonly Image[]
) {
  let next = 0
  const filled = grids.map((grid) => ({
    ...grid,
    slots: grid.slots.map((slot) =>
      !slot.assetId && next < images.length ? { ...slot, assetId: images[next++] } : slot
    ),
  }))
  return { filled, unused: images.slice(next) }
}

/** The bottom right cell of a concept set to the same label or image across the batch. */
export function withLastCell(grid: BatchGrid, last: { assetId?: string; topic?: string }) {
  const topic = last.topic?.trim()
  return withSlot(grid, GRID_LAST_SLOT, {
    ...(topic ? { topic } : {}),
    ...(last.assetId ? { assetId: last.assetId } : {}),
  })
}

/** A different concept in the same place: four other items, no images, the same music. */
export function redrawConcept(
  grid: BatchGrid,
  lines: readonly string[],
  random: () => number = Math.random
): BatchGrid {
  const pool = cleaned([...lines, ...grid.slots.map((slot) => slot.topic)])
  const shown = grid.slots.map((slot) => slot.topic).join('\n')
  let topics = draw(pool, GRID_SLOT_COUNT, random)
  for (let tries = 0; tries < 8 && topics.join('\n') === shown; tries++)
    topics = draw(pool, GRID_SLOT_COUNT, random)
  return { ...grid, slots: topics.map((topic) => ({ topic })) }
}

/**
 * Why a clip's length does not fit its place, or null. Lengths are compared to
 * the tenth of a second, as Go does, so an encoder's few extra milliseconds pass.
 */
export function clipLengthProblem(durationMs: number, range: { max: number; min: number }, what: string) {
  const length = Math.round(durationMs / 100) * 100
  if (Number.isFinite(length) && length >= range.min && length <= range.max) return null
  return `${what} must be ${range.min / 1000} to ${range.max / 1000} seconds long; this one is ${(durationMs / 1000).toFixed(1)}.`
}

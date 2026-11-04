import { lineDiff } from './diff'
import { activeFile, type CodeDocument, type CodeSlide, type CodeTransition } from './document'
import { compileTape } from './tape'

/**
 * A code project as a video (RFC 053). Each slide is a step: a transition
 * into it, then a hold. Everything here is a pure function of time, so a
 * preview and an exported frame at the same time look the same.
 */

/** A frame's place in the video. */
export type TimelineFrame = {
  /** The slide shown, or being transitioned into. */
  slide: number
  /** The slide transitioned from, during a transition. */
  from: number | null
  transition: CodeTransition | null
  /** Eased progress through the transition, 0 to 1; 1 while holding. */
  progress: number
  /** Milliseconds since the slide's transition began. */
  local: number
}

const TAPE_TAIL_MS = 800

/** How long a slide holds: its duration, or long enough to play its terminal script. */
export function slideHold(slide: CodeSlide): number {
  const scripts = slide.panes
    .map((pane) => activeFile(pane).tape)
    .filter((tape): tape is string => tape !== undefined)
  const script = Math.max(0, ...scripts.map((tape) => compileTape(tape).duration + TAPE_TAIL_MS))
  return Math.max(slide.duration, script)
}

/** How long the transition into a slide takes; the first slide only has one when it types. */
export function slideTransition(document: CodeDocument, index: number): number {
  const slide = document.slides[index]!
  if (index === 0) return slide.transition === 'type' ? slide.transitionDuration : 0
  return slide.transition === 'cut' ? 0 : slide.transitionDuration
}

/** Each slide's start, end of transition and end, in milliseconds. */
export function timeline(document: CodeDocument) {
  let at = 0
  return document.slides.map((slide, index) => {
    const start = at
    const transitionEnd = start + slideTransition(document, index)
    at = transitionEnd + slideHold(slide)
    return { start, transitionEnd, end: at }
  })
}

/** The video's length in milliseconds. */
export function videoDuration(document: CodeDocument): number {
  return timeline(document).at(-1)!.end
}

/** Ease in and out, so moving tokens start and settle gently. */
export function ease(progress: number): number {
  const p = Math.min(Math.max(progress, 0), 1)
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
}

/** Where the video is at `time` milliseconds. */
export function frameAt(document: CodeDocument, time: number): TimelineFrame {
  const spans = timeline(document)
  const t = Math.min(Math.max(time, 0), spans.at(-1)!.end)
  const found = spans.findIndex((span) => t < span.end)
  const slide = found === -1 ? spans.length - 1 : found
  const span = spans[slide]!
  const local = t - span.start
  const length = span.transitionEnd - span.start
  if (length > 0 && t < span.transitionEnd)
    return {
      slide,
      from: slide > 0 ? slide - 1 : null,
      transition: document.slides[slide]!.transition,
      progress: ease(local / length),
      local,
    }
  return { slide, from: null, transition: null, progress: 1, local }
}

/** A token placed on the character grid. */
export type GridToken = { key: string; content: string; color?: string; line: number; col: number }

/** Lay keyed tokens on a monospace grid: `\n` tokens end lines. */
export function placeTokens(
  tokens: readonly { key: string; content: string; color?: string }[]
): GridToken[] {
  const placed: GridToken[] = []
  let line = 0
  let col = 0
  for (const token of tokens) {
    if (token.content === '\n') {
      line++
      col = 0
      continue
    }
    placed.push({ key: token.key, content: token.content, color: token.color, line, col })
    // shortcut: a tab or wide glyph counts as one column; measure graphemes if users report misalignment.
    col += token.content.length
  }
  return placed
}

/** One token in a morph: where it moves from and to, and how visible it is. */
export type MorphToken = {
  key: string
  content: string
  color?: string
  line: number
  col: number
  opacity: number
}

/**
 * Tokens between two states at `progress`: matched tokens move, removed
 * ones fade out in the first half and added ones fade in in the second.
 */
export function morphTokens(from: GridToken[], to: GridToken[], progress: number): MorphToken[] {
  const target = new Map(to.map((token) => [token.key, token]))
  const source = new Set(from.map((token) => token.key))
  const lerp = (a: number, b: number) => a + (b - a) * progress
  const moving = from.map((token): MorphToken => {
    const next = target.get(token.key)
    if (!next) return { ...token, opacity: Math.max(0, 1 - progress * 2) }
    return {
      ...next,
      line: lerp(token.line, next.line),
      col: lerp(token.col, next.col),
      opacity: 1,
    }
  })
  const entering = to
    .filter((token) => !source.has(token.key))
    .map((token): MorphToken => ({ ...token, opacity: Math.max(0, progress * 2 - 1) }))
  return [...moving, ...entering]
}

/**
 * Characters to show per line while typing `after` over `before`: unchanged
 * lines show in full, added lines fill in order, one character at a time.
 */
export function typedLengths(before: string, after: string, progress: number): number[] {
  const lines = after.split('\n')
  const added = new Set(
    lineDiff(before, after)
      .filter((row) => row.kind === 'add')
      .map((row) => (row as { after: number }).after - 1)
  )
  const total = [...added].reduce((sum, index) => sum + lines[index]!.length + 1, 0)
  let budget = Math.round(total * Math.min(Math.max(progress, 0), 1))
  return lines.map((text, index) => {
    if (!added.has(index)) return text.length
    const shown = Math.min(text.length, budget)
    budget = Math.max(0, budget - text.length - 1)
    return shown
  })
}

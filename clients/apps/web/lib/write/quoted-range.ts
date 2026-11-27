import type { EditorAIRange } from '@shots/platejs-editor/lib'
import { SOCIAL_MENTION } from '@/lib/content-drafts/serialize'

type Node = {
  children?: Node[]
  handle?: string
  label?: string
  text?: string
  type?: string
  value?: string
}

type QuotePoint = EditorAIRange['anchor']

type TextSegment = {
  kind: 'text'
  path: number[]
  text: string
}

type MentionSegment = {
  atHandle: string
  atPrimary: string
  kind: 'mention'
  leafPath: number[]
  plainHandle: string
  plainPrimary: string
}

type Segment = MentionSegment | TextSegment
type MentionForm = 'atHandle' | 'atPrimary' | 'plainHandle' | 'plainPrimary'

const MENTION_FORMS: readonly MentionForm[] = [
  'atPrimary',
  'plainPrimary',
  'atHandle',
  'plainHandle',
]

function firstLeafPath(node: Node, path: number[]): number[] | null {
  if (typeof node.text === 'string') return path
  const children = node.children ?? []
  for (let index = 0; index < children.length; index += 1) {
    const found = firstLeafPath(children[index], [...path, index])
    if (found) return found
  }
  return null
}

function cleanHandle(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^@+/, '') : ''
}

function mentionSegment(node: Node, path: number[]): MentionSegment | null {
  if (node.type === 'mention') {
    const value = cleanHandle(node.value)
    const leafPath = firstLeafPath(node, path)
    if (!value || !leafPath) return null
    const at = `@${value}`
    return {
      atHandle: at,
      atPrimary: at,
      kind: 'mention',
      leafPath,
      plainHandle: value,
      plainPrimary: value,
    }
  }
  if (node.type === SOCIAL_MENTION) {
    const label = cleanHandle(node.label)
    const handle = cleanHandle(node.handle)
    const primary = label || handle
    const leafPath = firstLeafPath(node, path)
    if (!primary || !leafPath) return null
    const handleOrPrimary = handle || primary
    return {
      atHandle: `@${handleOrPrimary}`,
      atPrimary: `@${primary}`,
      kind: 'mention',
      leafPath,
      plainHandle: handleOrPrimary,
      plainPrimary: primary,
    }
  }
  return null
}

/** Every text leaf and inline mention of a block, with its path. */
function segments(node: Node, path: number[]): Segment[] {
  if (typeof node.text === 'string') return [{ kind: 'text', path, text: node.text }]
  const mention = mentionSegment(node, path)
  if (mention) return [mention]
  return (node.children ?? []).flatMap((child, index) => segments(child, [...path, index]))
}

/**
 * Strips common inline Markdown formatting (`**bold**`, `*italic*`, `` `code` ``,
 * `[label](url)`, `~~strike~~`, and backslash escapes) so quotes copied from
 * Markdown still match plain editor leaves.
 */
export function stripQuoteMarkdown(quote: string): string {
  let current = quote.trim()
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)/g, '$1')
      .replace(/(?<!\\)``([^`]+)``/g, '$1')
      .replace(/(?<!\\)`([^`]+)`/g, '$1')
      .replace(/(?<!\\)~~([^~]+?)~~/g, '$1')
      .replace(/(?<!\\)\*\*([^*]+?)(?<!\\)\*\*/g, '$1')
      .replace(/(?<![\w\\])__([^_]+?)(?<!\\)__(?!\w)/g, '$1')
      .replace(/(?<!\\)\*([^*]+?)(?<!\\)\*/g, '$1')
      .replace(/(?<![\w\\])_([^_]+?)(?<!\\)_(?!\w)/g, '$1')
    if (next === current) break
    current = next
  }
  return current.replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, '$1').trim()
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return a.length - b.length
}

function comparePoints(a: QuotePoint, b: QuotePoint): number {
  const pathOrder = comparePaths(a.path, b.path)
  return pathOrder !== 0 ? pathOrder : a.offset - b.offset
}

function isValidQuotePoint(point: QuotePoint): boolean {
  return (
    point.path.length > 0 &&
    point.path.every((segment) => Number.isInteger(segment) && segment >= 0) &&
    Number.isInteger(point.offset) &&
    point.offset >= 0
  )
}

function normalizeRange(range: EditorAIRange): { end: QuotePoint; start: QuotePoint } | null {
  if (!isValidQuotePoint(range.anchor) || !isValidQuotePoint(range.focus)) return null
  const order = comparePoints(range.anchor, range.focus)
  if (order === 0) return null
  return order < 0
    ? { end: range.focus, start: range.anchor }
    : { end: range.anchor, start: range.focus }
}

function segmentText(segment: Segment, form: MentionForm): string {
  return segment.kind === 'text' ? segment.text : segment[form]
}

function blockSearchBounds(
  parts: readonly Segment[],
  form: MentionForm,
  blockIndex: number,
  bounds: { end: QuotePoint; start: QuotePoint }
): { endOffset: number; startOffset: number } | null {
  const totalLength = parts.reduce((sum, part) => sum + segmentText(part, form).length, 0)
  const startOffset =
    blockIndex > bounds.start.path[0] ? 0 : pointToBlockOffset(parts, form, bounds.start, false)
  const endOffset =
    blockIndex < bounds.end.path[0]
      ? totalLength
      : pointToBlockOffset(parts, form, bounds.end, true)
  return startOffset < endOffset ? { endOffset, startOffset } : null
}

function pointToBlockOffset(
  parts: readonly Segment[],
  form: MentionForm,
  point: QuotePoint,
  isEnd: boolean
): number {
  let seen = 0
  for (const part of parts) {
    const length = segmentText(part, form).length
    const partPath = part.kind === 'text' ? part.path : part.leafPath
    const order = comparePaths(point.path, partPath)
    if (order < 0) return seen
    if (order === 0) {
      if (part.kind === 'text') {
        return seen + Math.max(0, Math.min(point.offset, length))
      }
      return isEnd ? seen + length : seen
    }
    seen += length
  }
  return seen
}

function adjacentTextLeaf(
  parts: readonly Segment[],
  index: number,
  direction: -1 | 1
): TextSegment | null {
  for (let cursor = index + direction; cursor >= 0 && cursor < parts.length; cursor += direction) {
    const part = parts[cursor]
    if (part.kind === 'text') return part
  }
  return null
}

function offsetToPoint(
  parts: readonly Segment[],
  form: MentionForm,
  offset: number,
  isEnd: boolean
): QuotePoint | null {
  let seen = 0
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const length = segmentText(part, form).length
    const end = seen + length
    const matches = isEnd ? offset <= end : offset < end
    if (!matches) {
      seen = end
      continue
    }
    if (part.kind === 'text') {
      return { offset: offset - seen, path: part.path }
    }
    if (!isEnd) {
      const prev = adjacentTextLeaf(parts, index, -1)
      return prev
        ? { offset: prev.text.length, path: prev.path }
        : { offset: 0, path: part.leafPath }
    }
    const next = adjacentTextLeaf(parts, index, 1)
    return next ? { offset: 0, path: next.path } : { offset: 0, path: part.leafPath }
  }
  return null
}

function matchInBlocks(
  children: readonly Node[],
  wanted: string,
  bounds?: { end: QuotePoint; start: QuotePoint }
): EditorAIRange | null {
  const firstBlock = bounds ? Math.max(0, bounds.start.path[0]) : 0
  const lastBlock = bounds ? Math.min(children.length - 1, bounds.end.path[0]) : children.length - 1

  for (let index = firstBlock; index <= lastBlock; index += 1) {
    const child = children[index]
    if (!child) continue
    const parts = segments(child, [index])
    const hasMention = parts.some((part) => part.kind === 'mention')
    const forms: readonly MentionForm[] = hasMention ? MENTION_FORMS : ['atPrimary']
    const seenTexts = new Set<string>()

    for (const form of forms) {
      const fullText = parts.map((part) => segmentText(part, form)).join('')
      if (seenTexts.has(fullText)) continue
      seenTexts.add(fullText)

      const window = bounds ? blockSearchBounds(parts, form, index, bounds) : null
      if (bounds && !window) continue

      const searchStart = window ? window.startOffset : 0
      const searchEnd = window ? window.endOffset : fullText.length
      const relative = fullText.slice(searchStart, searchEnd).indexOf(wanted)
      if (relative < 0) continue

      const start = searchStart + relative
      const end = start + wanted.length
      const anchor = offsetToPoint(parts, form, start, false)
      const focus = offsetToPoint(parts, form, end, true)
      if (anchor && focus) return { anchor, focus }
    }
  }
  return null
}

/**
 * The first place one block of `children` holds `quote`, as an editor range, or
 * null. Searches `preferredRange` first when provided (so reviewing a selection
 * attaches to the selected copy instead of an earlier duplicate), normalizes
 * Markdown syntax if needed, and includes mention nodes.
 */
export function quotedRange(
  children: readonly unknown[],
  quote: string,
  preferredRange?: EditorAIRange | null
): EditorAIRange | null {
  const exact = quote.trim()
  if (!exact) return null

  const stripped = stripQuoteMarkdown(exact)
  const candidates = stripped && stripped !== exact ? [exact, stripped] : [exact]
  const blocks = children as readonly Node[]
  const bounds = preferredRange ? normalizeRange(preferredRange) : null

  if (bounds) {
    for (const candidate of candidates) {
      const match = matchInBlocks(blocks, candidate, bounds)
      if (match) return match
    }
  }

  for (const candidate of candidates) {
    const match = matchInBlocks(blocks, candidate)
    if (match) return match
  }

  return null
}

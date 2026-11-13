'use client'

import type { Path, PluginConfig, TText, Value } from '@shots/platejs-editor/platejs'
import {
  createTPlatePlugin,
  type PlateEditor,
  PlateLeaf,
  type PlateLeafProps,
} from '@shots/platejs-editor/platejs/react'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import type { DraftChannel } from '@/lib/write/document'
import { postRanges } from './thread'

/**
 * The characters past a post's limit get a light red wash, as X shows them.
 * The host passes each post's excess for the platform being edited (from the
 * serialized post, so numbering and links count as they will publish), and
 * the trailing characters worth that much are marked.
 * shortcut: marks trailing visible characters by the serialized excess; a link
 * (23 on X and Mastodon), a Mastodon remote mention or a list marker counts
 * where it stands in the published text, so the mark can start a few characters
 * off there. Map serialized offsets back to Slate points if that matters to writers.
 */

/** Post number (1-based) to characters over the limit. */
export type PostExcess = Record<number, number>

type OverLimitConfig = PluginConfig<'over_limit', { channel: DraftChannel; excess: PostExcess }>

/** Each text leaf under `node` with its path, in document order. */
function* texts(node: unknown, path: Path): Generator<[string, Path]> {
  const entry = node as { children?: unknown[]; text?: unknown }
  if (typeof entry.text === 'string') {
    yield [entry.text, path]
    return
  }
  for (const [index, child] of (entry.children ?? []).entries()) yield* texts(child, [...path, index])
}

/** The overflowing [start, end) of each text leaf, by its path joined with ".". */
export function overflowRanges(
  children: Value,
  excess: PostExcess,
  channel: DraftChannel
): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>()
  postRanges(children).forEach(([start, end], index) => {
    let left = excess[index + 1] ?? 0
    for (let block = end - 1; block >= start && left > 0; block -= 1) {
      for (const [text, path] of [...texts(children[block], [block])].reverse()) {
        if (left <= 0) break
        let at = text.length
        while (at > 0 && left > 0) {
          // One code point at a time, weighed as the platform counts it.
          const code = text.charCodeAt(at - 1)
          const step = code >= 0xdc00 && code <= 0xdfff && at > 1 ? 2 : 1
          left -= Math.max(1, platformCaptionLength(channel, text.slice(at - step, at)))
          at -= step
        }
        if (at < text.length) ranges.set(path.join('.'), [at, text.length])
      }
    }
  })
  return ranges
}

/** Where post `number` goes past its limit, moved back to the start of that word. */
export function overflowStart(
  children: Value,
  number: number,
  excess: PostExcess,
  channel: DraftChannel
): { path: Path; offset: number } | null {
  const [start, end] = postRanges(children)[number - 1] ?? [0, 0]
  const ranges = overflowRanges(children, { [number]: excess[number] ?? 0 }, channel)
  for (let block = start; block < end; block += 1)
    for (const [text, path] of texts(children[block], [block])) {
      const range = ranges.get(path.join('.'))
      if (!range) continue
      const space = text.lastIndexOf(' ', range[0] - 1)
      const word = space >= 0 ? space + 1 : 0
      // Never split before the post's first word: that would leave it empty.
      return { offset: word === 0 && block <= start + 1 ? range[0] : word, path }
    }
  return null
}

let cache: { children: Value; key: string; ranges: Map<string, [number, number]> } | null = null

function OverLimitLeaf(props: PlateLeafProps) {
  return <PlateLeaf {...props} className="rounded-sm bg-destructive/15" />
}

/** The over-limit mark; the host sets `channel` and `excess` as the text changes. */
export const OverLimitPlugin = createTPlatePlugin<OverLimitConfig>({
  decorate: ({ editor, entry: [node, path], getOptions }) => {
    const { channel, excess } = getOptions()
    if (typeof (node as TText).text !== 'string' || Object.keys(excess).length === 0) return []
    const key = `${channel}:${JSON.stringify(excess)}`
    if (cache?.children !== editor.children || cache.key !== key)
      cache = { children: editor.children, key, ranges: overflowRanges(editor.children, excess, channel) }
    const range = cache.ranges.get(path.join('.'))
    return range
      ? [{ anchor: { offset: range[0], path }, focus: { offset: range[1], path }, over_limit: true }]
      : []
  },
  key: 'over_limit',
  node: { component: OverLimitLeaf, isLeaf: true },
  options: { channel: 'x', excess: {} },
})

/** Tell the editor each post's excess for the platform being edited, and redraw the marks. */
export function setOverLimit(editor: PlateEditor, channel: DraftChannel, excess: PostExcess): void {
  editor.setOptions(OverLimitPlugin, { channel, excess })
  editor.api.redecorate()
}

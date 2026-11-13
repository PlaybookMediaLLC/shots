import { platformCaptionLength, POST_BREAK, serializeDraft } from '@/lib/content-drafts/serialize'
import type { DraftChannel, Numbering, PlateBody } from './document'
import { threadLabels } from './numbering'
import { postBreak } from './versions'

type Node = { [key: string]: unknown; text?: string; type?: string; children?: Node[] }

/** Split text leaves at word/grapheme boundaries; links and mentions stay atomic. */
function pieces(node: Node): Node[] {
  if (typeof node.text !== 'string') return [node]
  return (node.text.match(/https?:\/\/[^\s]+|\s+|[^\s]+/gu) ?? ['']).map((text) => ({
    ...node,
    text,
  }))
}

/**
 * Make a thread without flattening marks, links, media or post settings.
 * Oversized atomic blocks are refused instead of discarded. Existing post
 * boundaries remain. Numbers reserve space but never enter the authored text.
 */
export function splitThread(
  body: PlateBody,
  channel: DraftChannel,
  limit: number,
  numbering?: Numbering
): PlateBody {
  if (!Number.isInteger(limit) || limit < 25 || limit > 25_000)
    throw new Error('Choose a post length from 25 to 25,000.')
  const label = threadLabels(25, numbering).filter((item): item is string => item !== null)
  const reserve = label.length
    ? Math.max(...label.map((item) => platformCaptionLength(channel, item))) + 1
    : 0
  const budget = limit - reserve
  const posts: Node[][] = []
  let current: Node[] = []
  const length = (nodes: Node[]) => serializeDraft(nodes, channel).length
  const start = (header?: Node) => {
    if (current.length) posts.push(current)
    current = [header ?? postBreak()]
    if (posts.length >= 25)
      throw new Error('This text needs more than 25 posts. Shorten it or increase the post length.')
  }
  for (const raw of body) {
    const node = structuredClone(raw) as Node
    if (node.type === POST_BREAK) {
      start(node)
      continue
    }
    if (!current.length) start()
    if (length([...current, node]) <= budget) {
      current.push(node)
      continue
    }
    if (current.length > 1) start()
    if (length([node]) <= budget) {
      current.push(node)
      continue
    }
    // Containers, embeds, lists and other atomic blocks retain their structure.
    if (!['p', 'h1', 'h2', 'h3', 'blockquote'].includes(node.type ?? '') || !node.children) {
      throw new Error('A block is longer than the post limit. Split that block manually.')
    }
    let fragment: Node = { ...node, children: [] }
    current.push(fragment)
    const append = (part: Node) => {
      const candidate = { ...fragment, children: [...(fragment.children ?? []), part] }
      if (length([...current.slice(0, -1), candidate]) > budget) {
        if (!fragment.children?.length)
          throw new Error('A link or mention is longer than the post limit. Increase the limit.')
        start()
        fragment = { ...node, id: undefined, children: [] }
        current.push(fragment)
        if (length([{ ...fragment, children: [part] }]) > budget)
          throw new Error('A link or mention is longer than the post limit. Increase the limit.')
      }
      fragment.children!.push(part)
    }
    for (const part of node.children.flatMap(pieces)) {
      if (
        typeof part.text === 'string' &&
        !/^https?:\/\//.test(part.text) &&
        length([{ ...node, children: [part] }]) > budget
      ) {
        for (const { segment } of new Intl.Segmenter(undefined, {
          granularity: 'grapheme',
        }).segment(part.text))
          append({ ...part, text: segment })
      } else append(part)
    }
  }
  if (current.length) posts.push(current)
  return posts.flat() as PlateBody
}

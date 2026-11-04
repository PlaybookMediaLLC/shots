import type { PlateEditor } from '@shots/platejs-editor/platejs/react'

/**
 * Formatting from the document editor that posts cannot carry (the post
 * editor brief): older drafts may hold headings, callouts, toggles, columns,
 * code, a table of contents, or colored and resized text. They still open
 * and publish as plain text; Convert to text makes the draft read that way.
 */

/** Blocks that publish as their plain text. */
const TEXT_BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'toggle', 'code_line'])
/** Blocks that hold other blocks (a callout may hold text instead). */
const CONTAINERS = new Set(['callout', 'code_block', 'column_group', 'column'])
/** Blocks that publish nothing. */
const DROPPED = new Set(['toc'])
/** Text styles a post cannot carry. */
export const STYLE_MARKS = [
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'highlight',
] as const

type Node = { children?: Node[]; text?: string; type?: string } & Record<string, unknown>

function isLegacy(node: Node): boolean {
  return typeof node.text === 'string'
    ? STYLE_MARKS.some((mark) => node[mark] !== undefined)
    : TEXT_BLOCKS.has(node.type ?? '') || CONTAINERS.has(node.type ?? '') || DROPPED.has(node.type ?? '')
}

/** How many nodes in a body carry formatting that posts as plain text. */
export function legacyCount(value: unknown): number {
  const visit = (nodes: unknown): number =>
    Array.isArray(nodes)
      ? nodes.reduce<number>((sum, node: Node) => sum + (isLegacy(node) ? 1 : 0) + visit(node.children), 0)
      : 0
  return visit(value)
}

/** Turn that formatting into plain paragraphs and unstyled text, as one undo step. */
export function convertLegacyBlocks(editor: PlateEditor): void {
  editor.tf.withNewBatch(() =>
    editor.tf.withoutNormalizing(() => {
      const texts = [
        ...editor.api.nodes({
          at: [],
          match: (node) => isLegacy(node as Node) && typeof (node as Node).text === 'string',
        }),
      ]
      for (const [, path] of texts) editor.tf.unsetNodes([...STYLE_MARKS], { at: path })
      // Deepest last in document order, so earlier siblings' paths stay valid.
      const blocks = [
        ...editor.api.nodes({
          at: [],
          match: (node) => isLegacy(node as Node) && typeof (node as Node).text !== 'string',
        }),
      ].reverse()
      for (const [entry, path] of blocks) {
        const node = entry as Node
        if (DROPPED.has(node.type ?? '')) editor.tf.removeNodes({ at: path })
        // A block that holds blocks (a callout of paragraphs, code lines) gives way to
        // them; one that holds text becomes the paragraph.
        else if (node.children?.some((child) => editor.api.isBlock(child as never)))
          editor.tf.unwrapNodes({ at: path })
        else editor.tf.setNodes({ type: 'p' }, { at: path })
      }
    })
  )
}

/** Inline elements, which stay inside their paragraph. */
const INLINE = new Set(['a', 'date', 'footnoteReference', 'inline_equation', 'mention', 'social_mention'])

/**
 * Nodes without the formatting posts cannot carry, as a paste brings them in:
 * headings and quotes become paragraphs, containers give way to their blocks,
 * a table of contents goes, and colors and fonts are dropped. Bold, italic,
 * links and lists stay, as the editor offers them.
 */
export function withoutLegacy<T>(nodes: readonly T[]): T[] {
  return nodes.flatMap((entry): T[] => {
    const node = entry as Node
    if (typeof node.text === 'string') {
      const text = { ...node }
      for (const mark of STYLE_MARKS) delete text[mark]
      return [text as T]
    }
    const type = node.type ?? ''
    if (DROPPED.has(type)) return []
    const children = withoutLegacy(node.children ?? [])
    if (CONTAINERS.has(type)) {
      const blocks = children.every(
        (child) => typeof (child as Node).text !== 'string' && !INLINE.has((child as Node).type ?? '')
      )
      return blocks ? (children as T[]) : [{ ...node, children, type: 'p' } as T]
    }
    return [{ ...node, children, ...(TEXT_BLOCKS.has(type) ? { type: 'p' } : {}) } as T]
  })
}

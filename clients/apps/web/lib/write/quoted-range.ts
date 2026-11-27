type Node = { children?: Node[]; text?: string }

/** Every text leaf of a block, with its path. */
function leaves(node: Node, path: number[]): Array<{ path: number[]; text: string }> {
  if (typeof node.text === 'string') return [{ path, text: node.text }]
  return (node.children ?? []).flatMap((child, index) => leaves(child, [...path, index]))
}

/**
 * The first place one block of `children` holds `quote`, as an editor range, or
 * null. A quote from the AI review is text it copied, so it is matched exactly.
 */
export function quotedRange(children: readonly unknown[], quote: string) {
  const wanted = quote.trim()
  if (!wanted) return null
  for (const [index, block] of (children as Node[]).entries()) {
    const parts = leaves(block, [index])
    const start = parts.map((part) => part.text).join('').indexOf(wanted)
    if (start < 0) continue
    const point = (offset: number, isEnd: boolean) => {
      let seen = 0
      for (const part of parts) {
        const end = seen + part.text.length
        if (isEnd ? offset <= end : offset < end) return { offset: offset - seen, path: part.path }
        seen = end
      }
      return null
    }
    const anchor = point(start, false)
    const focus = point(start + wanted.length, true)
    if (anchor && focus) return { anchor, focus }
  }
  return null
}

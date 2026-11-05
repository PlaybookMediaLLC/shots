/**
 * Transient combobox inputs (`@` mentions, `:` emoji, `#` hashtags, `/` commands)
 * never persist: each becomes literal text at every persistence boundary. A
 * half-typed slash command is not content, so it is dropped, never saved as "/".
 */
export function normalizeMentions<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeMentions) as T
  if (!value || typeof value !== 'object') return value
  const node = value as Record<string, unknown>
  if (typeof node.type === 'string' && node.type.endsWith('_input')) {
    if (node.type === 'slash_input') return { text: '' } as T
    const children = Array.isArray(node.children) ? node.children : []
    const text = typeof node.value === 'string' ? node.value : children.map((child) => child.text ?? '').join('')
    const trigger = typeof node.trigger === 'string' ? node.trigger : node.type === 'mention_input' ? '@' : ''
    return { text: `${trigger}${text}` } as T
  }
  return (Array.isArray(node.children) ? { ...node, children: node.children.map(normalizeMentions) } : node) as T
}

import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import type { TElement } from '@shots/platejs-editor/platejs'
import { PathApi } from '@shots/platejs-editor/platejs'

/** Find by identity at the time of an operation, never by a stale array index. */
export function attachmentEntry(editor: PlateEditor, id: string) {
  return [
    ...editor.api.nodes<TElement>({
      at: [],
      match: (node) => node.id === id && (node.type === 'img' || node.type === 'video'),
    }),
  ][0]
}

/** A block's attachments in document order, including media inside imported containers. */
export function attachmentsIn(node: TElement): TElement[] {
  if ((node.type === 'img' || node.type === 'video') && typeof node.assetId === 'string')
    return [node]
  return node.children.flatMap((child) => ('type' in child ? attachmentsIn(child as TElement) : []))
}

/**
 * Insert at the caret's post and leave the caret where it was, so typing carries on
 * and an empty post keeps its placeholder. An array keeps its order.
 */
export function insertAttachments(editor: PlateEditor, nodes: TElement[]) {
  if (!editor.selection) editor.tf.select(editor.api.end([]))
  editor.tf.insertNodes(nodes, { select: false })
}

/**
 * Remove one attachment. Saved and seeded nodes can lack an id, so those match
 * by asset: copies of one asset without ids are interchangeable.
 */
export function removeAttachment(editor: PlateEditor, node: Record<string, unknown>) {
  const [entry] = editor.api.nodes<TElement>({
    at: [],
    match: (candidate) =>
      (candidate.type === 'img' || candidate.type === 'video') &&
      (node.id ? candidate.id === node.id : candidate.assetId === node.assetId),
  })
  if (entry) editor.tf.removeNodes({ at: entry[1] })
}

/**
 * Give every attachment the identity moves and copies rely on. Media seeded
 * through the API or saved before node ids has none.
 */
export function ensureAttachmentIds(editor: PlateEditor) {
  const missing = [
    ...editor.api.nodes<TElement>({
      at: [],
      match: (node) => (node.type === 'img' || node.type === 'video') && !node.id,
    }),
  ]
  for (const [, path] of missing) editor.tf.setNodes({ id: crypto.randomUUID() }, { at: path })
}

/** Move before a current position, retaining identity, nested media, history and comments. */
export function moveAttachment(editor: PlateEditor, id: string, before: number | number[]) {
  const entry = attachmentEntry(editor, id)
  if (!entry) return
  const destination = typeof before === 'number' ? [before] : before
  if (PathApi.equals(entry[1], destination)) return
  const to = PathApi.transform(destination, { type: 'remove_node', path: entry[1], node: entry[0] })
  if (to && !PathApi.equals(entry[1], to)) editor.tf.moveNodes({ at: entry[1], to })
}

/** Resolve both drag identities at drop time, including media inside imported containers. */
export function moveAttachmentRelative(
  editor: PlateEditor,
  id: string,
  neighborId: string,
  after = false
) {
  const neighbor = attachmentEntry(editor, neighborId)
  if (neighbor) moveAttachment(editor, id, after ? PathApi.next(neighbor[1]) : neighbor[1])
}

/** Copy durable media metadata; the copy gets its own node identity. */
export function copyAttachment(editor: PlateEditor, id: string, before: number) {
  const entry = attachmentEntry(editor, id)
  if (!entry) return
  const node = structuredClone(entry[0])
  node.id = crypto.randomUUID()
  // Discussion anchors belong to the original node; media descriptions and transforms do not.
  node.children = [{ text: '' }]
  editor.tf.insertNodes(node, { at: [before], select: false })
}

/** Refresh asset-scoped descriptions across all saved platform versions without changing IDs. */
export function withAssetDescription<T>(value: T, assetId: string, alt: string): T {
  if (Array.isArray(value))
    return value.map((item) => withAssetDescription(item, assetId, alt)) as T
  if (!value || typeof value !== 'object') return value
  const node = value as Record<string, unknown>
  return Object.fromEntries(
    Object.entries({
      ...node,
      ...(node.type === 'img' && node.assetId === assetId ? { alt } : {}),
    }).map(([key, item]) => [key, withAssetDescription(item, assetId, alt)])
  ) as T
}

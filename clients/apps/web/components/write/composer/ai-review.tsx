'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AIChatPlugin } from '@shots/platejs-editor/@platejs/ai/react'
import {
  EDITOR_AI_COMMENT_EVENT,
  type EditorAICommentEventDetail,
  nid,
  useEditorServices,
} from '@shots/platejs-editor/lib'
import { RangeApi } from '@shots/platejs-editor/platejs'
import {
  createPlatePlugin,
  type PlateEditor,
  useEditorRef,
  usePluginOption,
} from '@shots/platejs-editor/platejs/react'
import type { discussionPlugin, TDiscussion } from '@shots/platejs-editor/plugins'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import { quotedRange } from '@/lib/write/quoted-range'

const DISCUSSION_PLUGIN = { key: 'discussion' } as unknown as typeof discussionPlugin

function isValidEditorPoint(
  editor: PlateEditor,
  point: { offset: number; path: number[] }
): boolean {
  const entry = editor.api.node(point.path)
  if (!entry) return false
  const [node] = entry
  return (
    'text' in node &&
    typeof node.text === 'string' &&
    Number.isInteger(point.offset) &&
    point.offset >= 0 &&
    point.offset <= node.text.length
  )
}

/**
 * Attaches one AI review comment to `editor` as a discussion thread when
 * `allowComments` is true and a visible text leaf in the matched range can be
 * marked. Returns true only when a comment thread actually attached.
 */
export function attachEditorAIComment(
  editor: PlateEditor,
  detail: EditorAICommentEventDetail,
  allowComments: boolean,
  notify: (message: string) => void = (message) => toast.info(message, { duration: 10_000 })
): boolean {
  if (!allowComments) {
    notify(`AI review: ${detail.comment}`)
    return false
  }
  const preferred = detail.selection ?? editor.selection
  const range = detail.content ? quotedRange(editor.children, detail.content, preferred) : preferred
  if (
    !range ||
    RangeApi.isCollapsed(range) ||
    !isValidEditorPoint(editor, range.anchor) ||
    !isValidEditorPoint(editor, range.focus)
  ) {
    notify(`AI review: ${detail.comment}`)
    return false
  }
  // Read text BEFORE setNodes({ split: true }) shifts leaf paths/offsets, and skip
  // void-only ranges (e.g. a lone mention) before mutating editor/Yjs/undo history.
  const rangeText = editor.api.string(range)
  if (!rangeText) {
    notify(`AI review: ${detail.comment}`)
    return false
  }
  const id = nid()
  const markKey = `comment_${id}`
  editor.tf.setNodes(
    { comment: true, [markKey]: true },
    { at: range, match: (node) => 'text' in node, split: true }
  )
  const marked = editor.api.some({
    at: [],
    match: (node) =>
      'text' in node &&
      typeof node.text === 'string' &&
      node.text.length > 0 &&
      Boolean((node as Record<string, unknown>)[markKey]),
  })
  if (!marked) {
    editor.tf.withoutSaving(() => {
      editor.tf.unsetNodes([markKey], {
        at: [],
        match: (node) => 'text' in node && Boolean((node as Record<string, unknown>)[markKey]),
      })
      editor.tf.unsetNodes(['comment'], {
        at: [],
        match: (node) =>
          'text' in node &&
          Boolean((node as Record<string, unknown>).comment) &&
          !Object.keys(node).some((key) => key.startsWith('comment_')),
      })
    })
    notify(`AI review: ${detail.comment}`)
    return false
  }
  const userId = editor.getOption(DISCUSSION_PLUGIN, 'currentUserId')
  const discussion: TDiscussion = {
    comments: [
      {
        contentRich: [{ children: [{ text: `AI review: ${detail.comment}` }], type: 'p' }],
        createdAt: new Date(),
        discussionId: id,
        id: nid(),
        isEdited: false,
        userId,
      },
    ],
    createdAt: new Date(),
    documentContent: rangeText,
    id,
    isResolved: false,
    userId,
  }
  editor.setOption(DISCUSSION_PLUGIN, 'discussions', [
    ...(editor.getOption(DISCUSSION_PLUGIN, 'discussions') ?? []),
    discussion,
  ])
  detail.markAttached?.()
  return true
}

/**
 * Two jobs the editor's AI leaves to its host. A review comment becomes a
 * comment thread on the passage it quotes. And the AI menu never opens on a
 * selection that crosses posts: replacing it would merge the thread.
 */
function EditorAIHost() {
  const editor = useEditorRef()
  const open = usePluginOption(AIChatPlugin, 'open')
  const allowComments = useEditorServices().ai?.comments !== false

  React.useEffect(() => {
    if (!open || !editor.selection) return
    const crosses = editor.api.some({ at: editor.selection, match: { type: POST_BREAK } })
    if (!crosses) return
    editor.getApi(AIChatPlugin).aiChat.hide()
    toast.info('Select text within one post, then ask the AI.')
  }, [editor, open])

  React.useEffect(() => {
    const comment = (event: Event) => {
      const detail = (event as CustomEvent<EditorAICommentEventDetail>).detail
      if (detail.editorId !== String(editor.id)) return
      attachEditorAIComment(editor, detail, allowComments)
    }
    window.addEventListener(EDITOR_AI_COMMENT_EVENT, comment)
    return () => window.removeEventListener(EDITOR_AI_COMMENT_EVENT, comment)
  }, [allowComments, editor])

  return null
}

export const EditorAIHostPlugin = createPlatePlugin({
  key: 'editor-ai-host',
  render: { afterEditable: () => <EditorAIHost /> },
})

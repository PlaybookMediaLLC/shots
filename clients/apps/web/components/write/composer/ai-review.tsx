'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AIChatPlugin } from '@shots/platejs-editor/@platejs/ai/react'
import { EDITOR_AI_COMMENT_EVENT, type EditorAICommentEventDetail, nid } from '@shots/platejs-editor/lib'
import { createPlatePlugin, useEditorRef, usePluginOption } from '@shots/platejs-editor/platejs/react'
import { discussionPlugin, type TDiscussion } from '@shots/platejs-editor/plugins'
import { POST_BREAK } from '@/lib/content-drafts/serialize'
import { quotedRange } from '@/lib/write/quoted-range'

/**
 * Two jobs the editor's AI leaves to its host. A review comment becomes a
 * comment thread on the passage it quotes. And the AI menu never opens on a
 * selection that crosses posts: replacing it would merge the thread.
 */
function EditorAIHost() {
  const editor = useEditorRef()
  const open = usePluginOption(AIChatPlugin, 'open')

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
      const range = detail.content ? quotedRange(editor.children, detail.content) : editor.selection
      if (!range) {
        toast.info(`AI review: ${detail.comment}`, { duration: 10_000 })
        return
      }
      const id = nid()
      const userId = editor.getOption(discussionPlugin, 'currentUserId')
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
        documentContent: editor.api.string(range),
        id,
        isResolved: false,
        userId,
      }
      editor.setOption(discussionPlugin, 'discussions', [
        ...(editor.getOption(discussionPlugin, 'discussions') ?? []),
        discussion,
      ])
      editor.tf.setNodes(
        { comment: true, [`comment_${id}`]: true },
        { at: range, match: (node) => 'text' in node, split: true }
      )
    }
    window.addEventListener(EDITOR_AI_COMMENT_EVENT, comment)
    return () => window.removeEventListener(EDITOR_AI_COMMENT_EVENT, comment)
  }, [editor])

  return null
}

export const EditorAIHostPlugin = createPlatePlugin({
  key: 'editor-ai-host',
  render: { afterEditable: () => <EditorAIHost /> },
})

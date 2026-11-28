import type { MdRules } from '@platejs/markdown'
import type { EditorAIAction, EditorServices, EditorUploadFile } from '@shots/platejs-editor/lib'
import { SOCIAL_MENTION } from '@/lib/content-drafts/serialize'
import type { DraftChannel } from '@/lib/write/document'
import { type SaveToWorkspaceInput, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { assetContentUrl } from './asset-url'

export { assetContentUrl }

type TrpcClient = SaveToWorkspaceInput['trpcClient']

/**
 * Markdown serializer rule for Shots `social_mention` nodes so AI prompts and
 * Markdown export include `@label` (or `@handle`) instead of dropping mentions.
 */
export function socialMentionMarkdownRules(): MdRules {
  const clean = (value: unknown) =>
    String(value ?? '')
      .trim()
      .replace(/^@+/, '')
  return {
    [SOCIAL_MENTION]: {
      serialize: (node) => {
        const raw = clean(node.label) || clean(node.handle)
        return { type: 'text', value: raw ? `@${raw}` : '' }
      },
    },
  }
}

/**
 * Stores an editor upload as a workspace asset: signed upload to R2 through the
 * Go backend, the same path saved exports take.
 */
export function workspaceUploadFile(trpcClient: TrpcClient): EditorUploadFile {
  return async (file, options) => {
    options?.onProgress?.(0)
    const { assetId } = await saveExportToWorkspace({ blob: file, fileName: file.name, onProgress: options?.onProgress, trpcClient })
    options?.onProgress?.(100)
    return {
      assetId,
      name: file.name,
      size: file.size,
      type: file.type,
      url: assetContentUrl(assetId),
    }
  }
}

/**
 * Uploads and AI wired to the platform for the post editor. With `ai`, the
 * editor's AI writes in that draft's voice for the platform being edited.
 */
export function platformEditorServices(
  trpcClient: TrpcClient,
  ai?: {
    actions?: readonly EditorAIAction[]
    channel: DraftChannel
    comments?: boolean
    draftId: string
    inlineSuggestions?: boolean
  }
): EditorServices {
  const query = ai && `?${new URLSearchParams({ channel: ai.channel, draftId: ai.draftId })}`
  return {
    ai: ai && {
      actions: ai.actions,
      chat: { api: `/api/ai/document${query}` },
      comments: ai.comments,
      copilot:
        ai.inlineSuggestions === false ? undefined : { api: `/api/ai/document/copilot${query}` },
    },
    uploadFile: workspaceUploadFile(trpcClient),
  }
}

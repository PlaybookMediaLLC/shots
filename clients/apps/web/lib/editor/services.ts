import type { EditorAIAction, EditorServices, EditorUploadFile } from '@shots/platejs-editor/lib'
import type { DraftChannel } from '@/lib/write/document'
import { type SaveToWorkspaceInput, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { assetContentUrl } from './asset-url'

export { assetContentUrl }

type TrpcClient = SaveToWorkspaceInput['trpcClient']

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
  ai?: { actions?: readonly EditorAIAction[]; channel: DraftChannel; draftId: string }
): EditorServices {
  const query = ai && `?${new URLSearchParams({ channel: ai.channel, draftId: ai.draftId })}`
  return {
    ai: ai && {
      actions: ai.actions,
      chat: { api: `/api/ai/document${query}` },
      copilot: { api: `/api/ai/document/copilot${query}` },
    },
    uploadFile: workspaceUploadFile(trpcClient),
  }
}

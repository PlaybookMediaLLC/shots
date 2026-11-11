import type { EditorServices, EditorUploadFile } from '@shots/platejs-editor/lib'
import type { DraftChannel } from '@/lib/write/document'
import { type SaveToWorkspaceInput, saveExportToWorkspace } from '@/lib/workspace/save-export'

type TrpcClient = SaveToWorkspaceInput['trpcClient']

/** The stable address of a workspace asset; it redirects to a signed URL. */
export function assetContentUrl(assetId: string): string {
  return `/api/v1/assets/${encodeURIComponent(assetId)}/content`
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
 * Uploads and AI wired to the platform for the document editor. With a draft,
 * the AI writes in that draft's voice for the platform being edited.
 */
export function platformEditorServices(
  trpcClient: TrpcClient,
  aiEnabled: boolean,
  voice: { channel: DraftChannel; draftId: string }
): EditorServices {
  const query = `?${new URLSearchParams(voice)}`
  return {
    ai: aiEnabled
      ? {
          chat: { api: `/api/ai/document${query}` },
          copilot: { api: `/api/ai/document/copilot${query}` },
        }
      : undefined,
    uploadFile: workspaceUploadFile(trpcClient),
  }
}

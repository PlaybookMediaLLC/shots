import type { EditorServices, EditorUploadFile } from '@shots/platejs-editor/lib'
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

/** Uploads wired to the platform for the document editor. AI is the assistant's job. */
export function platformEditorServices(trpcClient: TrpcClient): EditorServices {
  return { uploadFile: workspaceUploadFile(trpcClient) }
}

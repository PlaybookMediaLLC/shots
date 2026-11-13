import type { TRPCClient } from '@trpc/client'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import type { AppRouter } from '@/lib/trpc/router'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import {
  type DerivedFile,
  type DerivedSettings,
  replaceWithDerived,
} from '@/lib/write/media-operations'

/**
 * Save an image a tool made from an attachment's original, keep its
 * description, and put it on the attachment. The original stays in the
 * library; the new image is a derivative of it.
 */
export async function applyDerivedImage({
  alt,
  blob,
  client,
  editor,
  expectedAssetId,
  fileName,
  id,
  image,
  settings,
}: {
  alt: string
  blob: Blob
  client: TRPCClient<AppRouter>
  editor: PlateEditor
  expectedAssetId: unknown
  fileName: string
  id: string
  image: Omit<DerivedFile, 'assetId' | 'url'>
  settings: DerivedSettings
}) {
  const saved = await saveExportToWorkspace({
    blob,
    classification: 'derived',
    fileName,
    parentAssetId: image.sourceAssetId,
    trpcClient: client,
  })
  await call(`/api/v1/assets/${encodeURIComponent(saved.assetId)}/alt-text`, {
    body: { altText: alt },
    method: 'PUT',
  })
  replaceWithDerived(
    editor,
    id,
    expectedAssetId,
    { ...image, assetId: saved.assetId, url: assetContentUrl(saved.assetId) },
    settings
  )
}

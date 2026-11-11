'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { availableBrandCategories } from '@/lib/brand/apply'
import { type BrandKit, brandKitById, storedBrandKitSchema } from '@/lib/brand/kit'
import { applyBrandKitToEditor } from '@/lib/brand/library'
import { readEditorBrandKit } from '@/lib/platform/editor-handoff'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { buildExportFileName } from '@/lib/workspace/save-export'

/**
 * Loads a workspace asset into the editor when the URL carries
 * ?asset=<id>.
 *
 * This closes the loop the asset library opens: a saved export can come
 * back onto the canvas, take another pass, and be saved again. Without
 * it a workspace asset is a dead end that can only be downloaded.
 */
export function WorkspaceAssetLoader() {
  const trpcClient = useTRPCClient()
  // Guards the second effect run under React strict mode. The ref
  // survives the remount, so the asset loads exactly once.
  const startedRef = React.useRef(false)

  React.useEffect(() => {
    if (startedRef.current) return
    const assetId = new URLSearchParams(window.location.search).get('asset')
    if (!assetId) return
    startedRef.current = true

    async function load(id: string): Promise<void> {
      // The kit is read beside the download, so the brand follows the image at once.
      const kitId = readEditorBrandKit(window.location.search)
      const kit = kitId ? handoffKit(kitId) : null
      // Its failure is reported where it is awaited, after the image opens.
      kit?.catch(() => undefined)
      const { downloadUrl } = await trpcClient.asset.signDownload.query({ assetId: id })
      const response = await fetch(downloadUrl)
      if (!response.ok) {
        throw new Error(`The download failed with status ${response.status}.`)
      }
      const blob = await response.blob()
      if (!blob.type.startsWith('image/')) {
        toast.error('Only image assets can be edited', {
          description: 'Use Download on the assets page for video.',
        })
        return
      }
      const file = new File([blob], buildExportFileName(blob.type), { type: blob.type })
      // setImage writes the global store, so a strict-mode remount
      // between the fetch and this call is harmless.
      useImageStore.getState().setImage(file)
      // A screenshot handed over from a release or campaign opens on brand:
      // the workspace's active kit, applied as one undoable step.
      if (kit) await applyHandoffKit(kit)
      // Drop the parameters so a refresh keeps later edits instead of
      // reloading the original asset (and kit) over them.
      const url = new URL(window.location.href)
      url.searchParams.delete('asset')
      url.searchParams.delete('kit')
      window.history.replaceState(null, '', url)
    }

    // The exact version handed over, looked up among every stored version: a
    // newer draft of the kit must not hide the active one.
    async function handoffKit(kitId: string): Promise<BrandKit> {
      const { brandKits } = await trpcClient.brandKit.list.query()
      const kit = brandKitById(
        brandKits.flatMap((item) => {
          const parsed = storedBrandKitSchema.safeParse(item)
          return parsed.success ? [parsed.data] : []
        }),
        kitId
      )
      if (!kit) throw new Error('The brand kit could not be found in this workspace.')
      return kit
    }

    async function applyHandoffKit(pending: Promise<BrandKit>): Promise<void> {
      const progress = toast.loading('Applying the brand kit…')
      try {
        const kit = await pending
        await applyBrandKitToEditor(trpcClient, kit, availableBrandCategories(kit))
        toast.success(`Applied ${kit.name}`, { id: progress })
      } catch (error) {
        // The screenshot is open; only the kit is missing, and Brand can apply one.
        toast.error('Could not apply the brand kit', {
          description: error instanceof Error ? error.message : undefined,
          id: progress,
        })
      }
    }

    load(assetId).catch(() => {
      toast.error('Could not open the asset', {
        description: 'The asset may have been deleted, or the download expired. Try again from the assets page.',
      })
    })
  }, [trpcClient])

  return null
}

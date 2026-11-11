import type { TRPCClient } from '@trpc/client'
import type { CaptionChannel } from '@/lib/captions/channels'
import { exportDesignDocument } from '@/lib/design/export'
import { captureCanvasSnapshot } from '@/lib/design/snapshot'
import { useImageStore } from '@/lib/store'
import type { AppRouter } from '@/lib/trpc/router'

/**
 * Write alt text and a caption per channel for the open design, from its
 * snapshot and text, and keep them with the design. Captions are merged onto
 * what is saved when the answer arrives, so edits made meanwhile are kept.
 */
export async function writeDesignCaptions(
  trpcClient: TRPCClient<AppRouter>,
  request: { channels: CaptionChannel[]; notes?: string; socialSetId?: string }
): Promise<void> {
  const snapshot = await captureCanvasSnapshot(1024)
  if (!snapshot) throw new Error('The canvas could not be captured.')
  const written = await trpcClient.editorAi.captions.mutate({
    ...request,
    document: exportDesignDocument(),
    snapshot,
  })
  const latest = useImageStore.getState().copy
  useImageStore
    .getState()
    .setCopy({ altText: written.altText, captions: { ...latest?.captions, ...written.captions } })
}

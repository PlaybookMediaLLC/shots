'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { postRanges } from '@/components/drafts/thread'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import { draftAssetNode, supportedDraftMedia } from '@/lib/platform/asset-handoff'

/**
 * The node an attached export becomes.
 *
 * The editor names the media type it rendered, which lets the composer check
 * each destination's formats the way an attachment from the Library is
 * checked. The type is a hint from the browser, so an unsupported or missing
 * one falls back to a plain image node and the backend decides at schedule
 * time, as it did before the hint existed.
 */
function returnedNode(assetId: string, mediaType: string) {
  return supportedDraftMedia(mediaType)
    ? draftAssetNode({ id: assetId, mediaType })
    : {
        type: 'img',
        assetId,
        url: assetContentUrl(assetId),
        children: [{ text: '' }],
      }
}

/** An export returned from the Shots editor, reviewed before it joins a post. */
export function MediaImportDialog({
  editor,
  returnedAsset,
  returnedType = '',
  onClose,
}: {
  editor: PlateEditor
  returnedAsset: string
  /** The media type the editor rendered, when it said so. */
  returnedType?: string
  onClose: () => void
}) {
  const [post, setPost] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const ranges = postRanges(editor.children)
  const attach = async () => {
    setBusy(true)
    try {
      await call(`/api/v1/assets/${encodeURIComponent(returnedAsset)}/download-url`)
      const range = postRanges(editor.children)[post]
      if (!range) throw new Error('That post changed. Choose a destination again.')
      editor.tf.insertNodes(returnedNode(returnedAsset, returnedType), { at: [range[1]] })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The media could not be loaded.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" data-testid="draft-media-tools">
        <DialogHeader>
          <DialogTitle>Review the framed export</DialogTitle>
        </DialogHeader>
        <img
          alt="Framed export"
          src={`${assetContentUrl(returnedAsset)}?variant=thumbnail`}
          className="max-h-40 object-contain"
        />
        {ranges.length > 1 ? (
          <Label className="grid gap-1 text-sm">
            Destination post
            <Select value={String(post)} onValueChange={(value) => setPost(Number(value))}>
              <SelectTrigger aria-label="Media destination post">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ranges.map((_, index) => (
                  <SelectItem key={index} value={String(index)}>
                    Post {index + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
        ) : null}
        <Button disabled={busy} onClick={() => void attach()}>
          {busy ? 'Attaching…' : 'Attach framed export'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

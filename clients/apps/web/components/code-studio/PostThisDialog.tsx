'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { PaperPlaneTiltIcon } from '@phosphor-icons/react/dist/ssr/PaperPlaneTilt'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { toast } from 'sonner'
import { createWritingDraft } from '@/components/write/pending-draft'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { trackEvent } from '@/lib/analytics'
import { call } from '@/lib/content-drafts/client'
import { activeFile, type CodeDocument } from '@/lib/code-studio/document'
import { codeAltText, codePostBody, replyFitsX, type CodePostMedia } from '@/lib/code-studio/post'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace, WorkspaceSaveError } from '@/lib/workspace/save-export'

type Media = 'slide' | 'carousel' | 'video'

/** Props of {@link PostThisDialog}. */
export type PostThisDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: CodeDocument
  slideIndex: number
  /** Saves the open project first, when there is one. */
  flush?: () => Promise<boolean>
  /** Renders one slide as a PNG. */
  renderSlide: (index: number) => Promise<Blob>
  /** Renders the project as an MP4, when the browser can encode one. */
  renderVideo?: (onProgress: (progress: number) => void) => Promise<Blob>
  /** Writes a caption from the code, charged to AI credits. */
  writeCaption?: () => Promise<string>
}

/**
 * "Post this": the image (or every slide, or the video) becomes workspace
 * assets with the code as alt text, then a Publish draft opens with them
 * attached and, optionally, the code as a reply. Each step must succeed
 * before the next starts, so a failure never leaves a half-made draft.
 */
export function PostThisDialog({
  open,
  onOpenChange,
  document,
  slideIndex,
  flush,
  renderSlide,
  renderVideo,
  writeCaption,
}: PostThisDialogProps) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const id = React.useId()
  const many = document.slides.length > 1
  const [media, setMedia] = React.useState<Media>('slide')
  const [reply, setReply] = React.useState(false)
  const [caption, setCaption] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const file = activeFile(document.slides[slideIndex]!.panes[0]!)
  const code = file.tape !== undefined ? file.tape : file.code

  async function post() {
    setError(null)
    try {
      if (flush && !(await flush())) throw new Error('Save the project before posting it.')
      const indexes = media === 'carousel' ? document.slides.map((_, index) => index) : [slideIndex]
      const uploads: CodePostMedia[] = []
      if (media === 'video' && renderVideo) {
        setBusy('Rendering the video…')
        const blob = await renderVideo((progress) =>
          setBusy(`Rendering the video… ${Math.round(progress * 100)}%`)
        )
        setBusy('Uploading the video…')
        const { assetId } = await saveExportToWorkspace({
          blob,
          fileName: 'code-video.mp4',
          classification: 'export',
          trpcClient,
        })
        uploads.push({ id: assetId, mediaType: blob.type || 'video/mp4', alt: '' })
      } else {
        for (const [position, index] of indexes.entries()) {
          setBusy(
            indexes.length > 1
              ? `Uploading image ${position + 1} of ${indexes.length}…`
              : 'Uploading the image…'
          )
          const blob = await renderSlide(index)
          const { assetId } = await saveExportToWorkspace({
            blob,
            fileName: `code-${index + 1}.png`,
            classification: 'export',
            trpcClient,
          })
          const slideFile = activeFile(document.slides[index]!.panes[0]!)
          const alt = codeAltText(slideFile.tape ?? slideFile.code, slideFile.lang)
          await call(`/api/v1/assets/${encodeURIComponent(assetId)}/alt-text`, {
            method: 'PUT',
            body: { altText: alt },
          })
          uploads.push({ id: assetId, mediaType: 'image/png', alt })
        }
      }
      setBusy('Opening the draft…')
      trackEvent('code_studio_post', { media, reply, slides: indexes.length })
      onOpenChange(false)
      await createWritingDraft(
        {
          assetIds: uploads.map((item) => item.id),
          body: codePostBody({
            media: uploads,
            caption,
            reply: reply ? { code } : undefined,
          }),
        },
        (draftId) => router.push(`/publish/${encodeURIComponent(draftId)}`)
      )
    } catch (failure) {
      const message =
        failure instanceof WorkspaceSaveError || failure instanceof Error
          ? failure.message
          : 'The post could not be prepared. Your project is unchanged.'
      setError(message)
      toast.error('Could not prepare the post', { description: message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Post this</DialogTitle>
          <DialogDescription>
            The image is saved to your workspace with the code as its alt text, then a draft opens
            in Publish for you to schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {many || renderVideo ? (
            <div className="space-y-1.5">
              <Label>Attach</Label>
              <SegmentedControl
                ariaLabel="Attach"
                size="sm"
                value={media}
                onChange={(value) => setMedia(value as Media)}
                options={[
                  { id: 'slide', label: 'This slide' },
                  ...(many
                    ? [{ id: 'carousel', label: `All ${document.slides.length} slides` }]
                    : []),
                  ...(renderVideo ? [{ id: 'video', label: 'Video' }] : []),
                ]}
              />
              {media === 'carousel' && document.slides.length > 4 ? (
                <p className="text-xs text-muted-foreground">
                  X takes up to 4 images and LinkedIn up to 20; Publish lets you choose per channel.
                </p>
              ) : null}
              {media === 'video' ? (
                <p className="text-xs text-muted-foreground">
                  An MP4: X posts it on its own, LinkedIn needs 3 seconds or more, and TikTok takes
                  one video.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor={`${id}-caption`}>Caption</Label>
              {writeCaption ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy('Writing a caption…')
                    try {
                      setCaption(await writeCaption())
                    } catch (failure) {
                      toast.error(
                        failure instanceof Error ? failure.message : 'No caption was written.'
                      )
                    } finally {
                      setBusy(null)
                    }
                  }}
                >
                  <SparkleIcon /> Write caption
                </Button>
              ) : null}
            </div>
            <Textarea
              id={`${id}-caption`}
              value={caption}
              maxLength={3_000}
              placeholder="Optional. You can also write it in Publish."
              onChange={(event) => setCaption(event.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-reply`} className="font-normal">
              Add the code as a reply
            </Label>
            <Switch id={`${id}-reply`} checked={reply} onCheckedChange={setReply} />
          </div>
          {reply && !replyFitsX(code) ? (
            <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
              This code is longer than 280 characters. On X it needs a Premium account, or split it
              into a thread in Publish.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={!!busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!!busy} onClick={post} aria-busy={!!busy}>
            <PaperPlaneTiltIcon /> {busy ?? 'Create draft'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import * as React from 'react'
import { CopySimpleIcon } from '@phosphor-icons/react/dist/ssr/CopySimple'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'
import { trackEvent } from '@/lib/analytics'
import { activeFile, codeDocumentSchema, type CodeDocument } from '@/lib/code-studio/document'
import { codeAltText } from '@/lib/code-studio/post'
import { embedSnippets, shareUrl } from '@/lib/sharing/schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'

/** Props of {@link ShareEmbedDialog}. */
export type ShareEmbedDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: CodeDocument
  slideIndex: number
  name: string
  renderSlide: (index: number) => Promise<Blob>
}

/**
 * Publish a code embed for blogs and docs: a share link whose page shows the
 * image and whose embed shows the code as real, copyable text. The link keeps
 * a frozen copy, so later edits never reach readers; make a new link instead.
 */
export function ShareEmbedDialog({
  open,
  onOpenChange,
  document,
  slideIndex,
  name,
  renderSlide,
}: ShareEmbedDialogProps) {
  const client = useTRPCClient()
  const [busy, setBusy] = React.useState(false)
  const [snippets, setSnippets] = React.useState<{ url: string; iframe: string } | null>(null)

  const create = async () => {
    setBusy(true)
    try {
      const blob = await renderSlide(slideIndex)
      const { assetId } = await saveExportToWorkspace({
        blob,
        fileName: 'code-embed.png',
        classification: 'export',
        trpcClient: client,
      })
      // The embed shows one slide, publicly; the footer logo is a private asset.
      const slide = document.slides[slideIndex]!
      const snapshot = codeDocumentSchema.parse({
        ...document,
        style: { ...document.style, footer: { ...document.style.footer, logo: undefined } },
        slides: [slide],
      })
      const file = activeFile(slide.panes[0]!)
      const { shareLink } = await client.shareLink.create.mutate({
        access: 'PUBLIC',
        expiry: 'never',
        assetId,
        title: name || file.name || 'Code',
        altText: codeAltText(file.tape ?? file.code, file.lang),
        code: snapshot,
      })
      const origin = window.location.origin
      setSnippets({
        url: shareUrl(origin, shareLink.token),
        iframe: embedSnippets(origin, shareLink).iframe,
      })
      trackEvent('code_studio_embed', { slides: 1 })
    } catch (failure) {
      toast.error('The embed could not be created', {
        description: failure instanceof Error ? failure.message : 'Try again.',
      })
    } finally {
      setBusy(false)
    }
  }

  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast.success('Copied'),
      () => toast.error('Could not copy')
    )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) setSnippets(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Embed this code</DialogTitle>
          <DialogDescription>
            Anyone with the link can see this slide&apos;s code and copy it. The embed is a frozen
            copy; to update it, create a new one and revoke the old link in Library › Assets.
          </DialogDescription>
        </DialogHeader>
        {snippets ? (
          <div className="space-y-4">
            {[
              { label: 'Link', value: snippets.url },
              { label: 'Embed (iframe)', value: snippets.iframe },
            ].map((item) => (
              <div key={item.label} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>{item.label}</Label>
                  <Button variant="ghost" size="sm" onClick={() => copy(item.value)}>
                    <CopySimpleIcon /> Copy
                  </Button>
                </div>
                <Textarea
                  readOnly
                  value={item.value}
                  className="font-mono text-xs"
                  aria-label={item.label}
                />
              </div>
            ))}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {snippets ? 'Done' : 'Cancel'}
          </Button>
          {snippets ? null : (
            <Button disabled={busy} onClick={create}>
              {busy ? 'Publishing…' : 'Create public embed'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

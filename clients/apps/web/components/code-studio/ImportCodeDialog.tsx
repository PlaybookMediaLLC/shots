'use client'

import * as React from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { trackEvent } from '@/lib/analytics'
import { CODE_FILE_LIMIT, type CodeDocument } from '@/lib/code-studio/document'
import { fileSlide, importedSlides, withImport, type ImportMode } from '@/lib/code-studio/import'
import { useTRPCClient } from '@/lib/trpc/react'

/** Props of {@link ImportCodeDialog}. */
export type ImportCodeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: CodeDocument
  slideIndex: number
  onImport: (document: CodeDocument, slide: number) => void
  /** A link to prefill, such as a pull request from a campaign's release. */
  initialUrl?: string
}

/**
 * Bring code in from a GitHub file permalink (with a line range), a pull
 * request, a commit or a gist, or open a local file. Links are read only when
 * the member asks; a local file never leaves the browser until they save.
 */
export function ImportCodeDialog({
  open,
  onOpenChange,
  document,
  slideIndex,
  onImport,
  initialUrl = '',
}: ImportCodeDialogProps) {
  const client = useTRPCClient()
  const id = React.useId()
  const [url, setUrl] = React.useState(initialUrl)
  const [mode, setMode] = React.useState<ImportMode>('diff')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const change = /\/(pull|commit)\//.test(url)

  const apply = (next: ReturnType<typeof withImport>, kind: string) => {
    onImport(next.document, next.slide)
    trackEvent('code_studio_import', { kind, slides: next.document.slides.length })
    setUrl('')
    onOpenChange(false)
  }

  const importLink = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await client.codeProject.importLink.mutate({ url })
      const slides = importedSlides(result, mode)
      if (!slides.length) throw new Error('That link had no code to import.')
      apply(withImport(document, slides, slideIndex, result), result.kind)
      if (result.files.length >= 20) toast.message('Only the first 20 changed files were imported.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That link could not be imported.')
    } finally {
      setBusy(false)
    }
  }

  const fileInput = React.useRef<HTMLInputElement>(null)

  const openFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    const text = await file.text()
    if (text.length > CODE_FILE_LIMIT || text.includes('\u0000'))
      return setError('Choose a text file under 100,000 characters.')
    apply(withImport(document, [fileSlide(file.name, text)], slideIndex), 'file')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-lg"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          void openFile(event.dataTransfer.files[0])
        }}
      >
        <DialogHeader>
          <DialogTitle>Import code</DialogTitle>
          <DialogDescription>
            Paste a GitHub link, or drop a file here. Shots reads a link only when you import it and
            keeps the code only in this project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void importLink()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>GitHub link</Label>
            <Input
              id={`${id}-url`}
              value={url}
              type="url"
              inputMode="url"
              placeholder="https://github.com/org/repo/blob/main/src/app.ts#L10-L24"
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A file with an optional line range, a pull request, a commit or a gist. Private
              repositories need the workspace&apos;s GitHub connection.
            </p>
          </div>
          {change ? (
            <div className="space-y-1.5">
              <Label>Show the change as</Label>
              <SegmentedControl
                ariaLabel="Show the change as"
                size="sm"
                value={mode}
                onChange={(value) => setMode(value as ImportMode)}
                options={[
                  { id: 'diff', label: 'A diff per file' },
                  { id: 'animate', label: 'Before → after (video)' },
                ]}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            {/* Any file: code has no fixed type, and a dropped file works too. */}
            <Input
              ref={fileInput}
              type="file"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void openFile(file)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              Open a file…
            </Button>
            <span className="text-xs text-muted-foreground">or drop one on this dialog</span>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? 'Importing…' : 'Import link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

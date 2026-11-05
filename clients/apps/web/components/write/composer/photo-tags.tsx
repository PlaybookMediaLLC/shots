'use client'
import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { attachmentEntry } from '@/lib/write/media-operations'
import { call } from '@/lib/content-drafts/client'

type Tag = { providerId: string; handle?: string; label: string }

/** Native IDs are separate from caption mentions; tags never consume caption characters. */
export function PhotoTags({
  editor,
  id,
  setId,
  onClose,
}: {
  editor: PlateEditor
  id: string
  setId: string | null
  onClose: () => void
}) {
  const [sourceAssetId] = React.useState(() => attachmentEntry(editor, id)?.[0].assetId)
  const [tags, setTags] = React.useState<Tag[]>(
    () => (attachmentEntry(editor, id)?.[0].photoTags as Tag[] | undefined) ?? []
  )
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<Tag[] | null>(null)
  const [busy, setBusy] = React.useState(false)
  const search = async () => {
    if (!setId) return
    setBusy(true)
    try {
      const found = await call<{ items: Tag[] }>(
        `/api/v1/social-sets/${encodeURIComponent(setId)}/mentions?${new URLSearchParams({ channel: 'x', q: query })}`
      )
      setResults(found.items.filter((tag) => /^\d{1,19}$/.test(tag.providerId)))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'X account lookup failed. Try again later.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tag people in photos</DialogTitle>
          <DialogDescription>
            X applies up to ten people across the post’s photos. Notifications depend on X and the
            tagged person’s settings. Native publishing remains blocked until this installation
            verifies account permission.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void search()
          }}
        >
          <Input
            aria-label="X username to tag"
            placeholder="Exact X username"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button disabled={busy || !setId || !query.trim()}>Find person</Button>
        </form>
        {!setId ? <p>Choose a profile with a connected X account.</p> : null}
        {results?.length === 0 ? <p role="status">No eligible account found.</p> : null}
        {results?.map((tag) => (
          <Button
            key={tag.providerId}
            variant="outline"
            disabled={tags.length >= 10 || tags.some((item) => item.providerId === tag.providerId)}
            onClick={() => setTags([...tags, tag])}
          >
            Add {tag.label} @{tag.handle}
          </Button>
        ))}
        {tags.map((tag) => (
          <Button
            key={tag.providerId}
            variant="ghost"
            onClick={() => setTags(tags.filter((item) => item.providerId !== tag.providerId))}
          >
            Remove {tag.label}
          </Button>
        ))}
        <Button
          onClick={() => {
            const entry = attachmentEntry(editor, id)
            if (!entry || entry[0].assetId !== sourceAssetId) {
              toast.error('This attachment changed. Reopen photo tagging for the current image.')
              return
            }
            editor.tf.setNodes({ photoTags: tags }, { at: entry[1] })
            onClose()
          }}
        >
          Save photo tags
        </Button>
      </DialogContent>
    </Dialog>
  )
}

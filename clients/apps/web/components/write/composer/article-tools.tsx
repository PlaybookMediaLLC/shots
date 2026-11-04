'use client'
import * as React from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { Article } from '@/lib/write/document'
import { toast } from 'sonner'

/** Article metadata and native X embeds stored alongside the shared Plate body. */
export function ArticleTools({
  article,
  onChange,
  editor,
  upload,
}: {
  article: Article | null
  onChange: (article: Article) => void
  editor: React.RefObject<PlateEditor | null>
  upload?: (file: File) => Promise<{ assetId?: string }>
}) {
  const [url, setURL] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  return (
    <div className="grid gap-2 px-4 py-2">
      <Label className="grid gap-1 text-xs">
        Article title
        <Input
          value={article?.title ?? ''}
          maxLength={200}
          onChange={(event) => onChange({ ...article, title: event.target.value })}
        />
      </Label>
      <div className="grid gap-1 text-xs">
        <span>Cover image</span>
        <FileDropZone
          accept={{ 'image/jpeg': [], 'image/png': [], 'image/webp': [] }}
          busy={busy}
          disabled={!upload}
          hint="JPEG, PNG or WebP."
          label="Article cover image"
          onFiles={async ([file]) => {
            if (!file || !upload) return
            setBusy(true)
            try {
              const result = await upload(file)
              if (result.assetId)
                onChange({
                  title: article?.title ?? '',
                  ...article,
                  coverAssetId: result.assetId,
                })
            } catch {
              toast.error('The cover could not be uploaded.')
            } finally {
              setBusy(false)
            }
          }}
          onRemove={() => onChange({ title: article?.title ?? '' })}
          preview={article?.coverAssetId ? <span>Cover image added</span> : null}
        />
      </div>
      <div className="flex gap-2">
        <Input
          aria-label="X post to embed"
          placeholder="https://x.com/…/status/…"
          value={url}
          onChange={(event) => setURL(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (
              !/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/\d{1,30}(?:[/?#].*)?$/.test(
                url
              )
            ) {
              toast.error('Use an X post URL.')
              return
            }
            editor.current?.tf.insertNodes(
              { type: 'media_embed', url, children: [{ text: '' }] },
              { at: [editor.current.children.length] }
            )
            setURL('')
          }}
        >
          Embed post
        </Button>
      </div>
    </div>
  )
}

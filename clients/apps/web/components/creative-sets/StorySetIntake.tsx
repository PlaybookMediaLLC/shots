'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { trackEvent } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ProjectPreview } from '@/components/projects/ProjectPreview'
import { useTRPCClient } from '@/lib/trpc/react'
import { uploadSource } from '@/lib/design/upload-sources'
import { createCreativeSet } from '@/lib/creative-sets/recipes'
import {
  newCreativeSetId,
  TREATMENTS,
  type FocusRegion,
  type StorySource,
  type Treatment,
  type CreativeSetDocument,
} from '@/lib/creative-sets/document'
import { FocusPicker } from './FocusPicker'

/** Decode and upload before references enter a saved or recoverable set. */
export async function uploadStoryScreenshot(
  file: File,
  client: ReturnType<typeof useTRPCClient>
): Promise<{ source: StorySource; url: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('Choose a PNG, JPEG, or WebP screenshot.')
  if (file.size > 50 * 1024 * 1024) throw new Error('Choose a screenshot smaller than 50 MB.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const src = await uploadSource(client, url)
    return {
      url,
      source: {
        id: crypto.randomUUID(),
        revision: 1,
        src,
        name: file.name.slice(0, 200),
        width: image.naturalWidth,
        height: image.naturalHeight,
      },
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

export function StorySetIntake({
  onCancel,
  onAdd,
}: {
  onCancel: () => void
  onAdd?: (document: CreativeSetDocument) => void
}) {
  const client = useTRPCClient(),
    router = useRouter()
  const intent = useRef<{
    signature: string
    id: string
    document: ReturnType<typeof createCreativeSet>
  } | null>(null)
  const [name, setName] = useState('Feature announcement')
  const [headline, setHeadline] = useState('')
  const [supporting, setSupporting] = useState('')
  const [image, setImage] = useState<{ source: StorySource; url: string } | null>(null)
  const [focus, setFocus] = useState<FocusRegion>({ x: 0.25, y: 0.25, width: 0.3, height: 0.3 })
  const [treatment, setTreatment] = useState<Treatment>('detail-spotlight')
  const [startedAt] = useState(() => Date.now())
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const previews = useMemo(
    () =>
      image
        ? (Object.keys(TREATMENTS) as Treatment[]).map((id) => ({
            id,
            document: createCreativeSet({
              headline: headline.trim() || 'Your product benefit',
              supporting,
              source: image.source,
              focus,
              treatment: id,
            }).outputs[0]!.document,
          }))
        : [],
    [headline, supporting, image, focus]
  )
  async function create() {
    if (!image) return
    setBusy(true)
    setError(null)
    try {
      const input = { headline, supporting, source: image.source, focus, treatment }
      const signature = JSON.stringify({ name, ...input })
      if (intent.current?.signature !== signature)
        intent.current = { signature, id: newCreativeSetId(), document: createCreativeSet(input) }
      if (onAdd) {
        onAdd(intent.current.document)
        return
      }
      const result = await client.creativeSet.create.mutate({
        id: intent.current.id,
        name,
        document: intent.current.document,
      })
      trackEvent('story_set_created', {
        treatment,
        duration_ms: Date.now() - startedAt,
        outputs: 3,
      })
      router.push(`/creative-sets/${result.id}`)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Creation failed.')
      setBusy(false)
    }
  }
  return (
    <section className="w-full px-8 py-10">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            One benefit · three formats
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Tell a product story</h1>
          <p className="mt-2 text-muted-foreground">
            One clear benefit, the screenshot that proves it, and three connected formats.
          </p>
        </div>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
      <div className="grid gap-8 lg:grid-cols-[320px_1fr]">
        <div className="space-y-5 rounded-xl border bg-foreground/[0.02] p-5">
          <Label className="grid gap-2 text-sm" hidden={Boolean(onAdd)}>
            Story Set name
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} />
          </Label>
          <Label className="grid gap-2 text-sm">
            Story headline
            <Textarea
              value={headline}
              onChange={(event) => setHeadline(event.target.value)}
              maxLength={300}
              placeholder="See what needs your decision"
            />
          </Label>
          <Label className="grid gap-2 text-sm">
            Supporting line (optional)
            <Textarea
              value={supporting}
              onChange={(event) => setSupporting(event.target.value)}
              maxLength={300}
            />
          </Label>
          <Label className="grid gap-2 text-sm">
            Product screenshot
            <Input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setBusy(true)
                setError(null)
                try {
                  const next = await uploadStoryScreenshot(file, client)
                  if (image) URL.revokeObjectURL(image.url)
                  setImage(next)
                } catch (error) {
                  setError(error instanceof Error ? error.message : 'Upload failed.')
                } finally {
                  setBusy(false)
                }
              }}
            />
          </Label>
          <p className="text-xs text-muted-foreground">
            Start with a neutral style. Add your brand and adjust each format in the editor.
          </p>
        </div>
        <div>
          {image ? (
            <FocusPicker src={image.url} value={focus} onChange={setFocus} />
          ) : (
            <div className="grid min-h-72 place-items-center rounded-xl border border-dashed bg-foreground/[0.02] text-sm text-muted-foreground">
              Your screenshot becomes the evidence.
            </div>
          )}
        </div>
      </div>
      {image ? (
        <div className="mt-8 border-t pt-6">
          <h2 className="mb-4 text-ui-lg font-medium">Choose a visual treatment</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {previews.map(({ id, document }) => (
              <Button
                key={id}
                variant="custom"
                size={null}
                type="button"
                aria-pressed={treatment === id}
                onClick={() => setTreatment(id)}
                className={`overflow-hidden rounded-xl border text-left ${treatment === id ? 'border-emerald-500/70 ring-1 ring-emerald-500/30' : 'border-foreground/10 hover:border-foreground/30'}`}
              >
                <div className="aspect-video">
                  <ProjectPreview alt={TREATMENTS[id]} document={document} />
                </div>
                <div className="border-t p-4">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-ui-lg font-medium">{TREATMENTS[id]}</strong>
                    {treatment === id ? (
                      <span className="text-xs text-emerald-400">Selected</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {id === 'product-hero'
                      ? 'Lead with a clear message and the whole product.'
                      : id === 'editorial-split'
                        ? 'Give copy and evidence their own space.'
                        : id === 'detail-spotlight'
                          ? 'Keep context. Enlarge the detail that matters.'
                          : 'Let the UI lead. A focused crop on a brand backdrop.'}
                  </p>
                </div>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-5 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-8 flex justify-end">
        <Button
          disabled={busy || !image || !headline.trim() || !name.trim()}
          onClick={() => void create()}
        >
          {busy ? 'Working…' : 'Create three formats'}
        </Button>
      </div>
    </section>
  )
}

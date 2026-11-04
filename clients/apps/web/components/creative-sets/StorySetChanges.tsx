'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { ProjectPreview } from '@/components/projects/ProjectPreview'
import { applySetCommand } from '@/lib/creative-sets/commands'
import {
  outputDimensions,
  type CreativeSetDocument,
  type FocusRegion,
  type StorySource,
  storyForOutput,
} from '@/lib/creative-sets/document'
import type { CreativeSetSession } from '@/lib/creative-sets/session'
import { fetchAssetUrl } from '@/lib/design/open-design'
import dynamic from 'next/dynamic'
const StoreGroupPreview = dynamic(
  () => import('./StoreGroupPreview').then((module) => module.StoreGroupPreview),
  { ssr: false }
)
import { FocusPicker } from './FocusPicker'
import { uploadStoryScreenshot } from './StorySetIntake'

export function ChangeComparison({
  before,
  after,
  storyId,
}: {
  before: CreativeSetDocument
  after: CreativeSetDocument
  storyId?: string
}) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {after.outputs
        .filter((output) => !storyId || output.storyId === storyId)
        .map((output) => (
          <div key={output.id} className="space-y-2">
            <h3 className="text-ui-lg font-medium">
              {storyForOutput(after, output).headline} · {outputDimensions(output).name}
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Before</p>
                <div className="aspect-square">
                  <ProjectPreview
                    alt={`Previous ${output.format}`}
                    document={
                      before.outputs.find((item) => item.id === output.id)?.document ?? null
                    }
                  />
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">After</p>
                <div className="aspect-square">
                  <ProjectPreview alt={`Updated ${output.format}`} document={output.document} />
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {output.overrides.headline
                ? 'Custom headline preserved. '
                : 'Headline linked to story. '}
              {output.review.source ? 'Check crop and focus. ' : ''}
              {output.review.redactions ? 'Review redactions. ' : ''}Local style and placement stay
              with this format.
            </p>
          </div>
        ))}
      {after.storeGroups
        .filter(
          (group) => !storyId || group.bindings.some((binding) => binding.storyId === storyId)
        )
        .map((group) => {
          const previous = before.storeGroups.find((item) => item.id === group.id)
          return (
            <section key={group.id} className="space-y-2 md:col-span-3">
              <h3 className="text-ui-lg font-medium">{group.name} · Store slides</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="mb-2 text-xs">Before</p>
                  {previous ? <StoreGroupPreview group={previous} /> : null}
                </div>
                <div>
                  <p className="mb-2 text-xs">After</p>
                  <StoreGroupPreview group={group} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Local slide typography and placement are preserved. Review linked screenshots after
                applying.
              </p>
            </section>
          )
        })}
    </div>
  )
}

export function SourceUpdate({
  session,
  storyId,
  onClose,
}: {
  session: CreativeSetSession
  storyId: string
  onClose: () => void
}) {
  const [before] = useState(() => session.snapshot().document)
  const story = before.stories.find((story) => story.id === storyId)!
  const [image, setImage] = useState<{ source: StorySource; url: string } | null>(null),
    [oldUrl, setOldUrl] = useState<string | null>(null)
  const [focus, setFocus] = useState<FocusRegion>(story.focus),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void fetchAssetUrl(session.client, story.source.src.slice(6))
      .then((url) => {
        if (active) setOldUrl(url)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [session, story])
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image.url)
    },
    [image]
  )
  const after = useMemo(
    () =>
      image
        ? applySetCommand(before, { type: 'replace-source', storyId, source: image.source, focus })
        : null,
    [before, image, focus, storyId]
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-5xl">
        <DialogTitle>Review a product update</DialogTitle>
        <DialogDescription>
          Replace the shared evidence and select its focus again. Review each affected format after
          applying. Local copy, styling and placement are preserved.
        </DialogDescription>
        <FileDropZone
          accept={{ 'image/png': [], 'image/jpeg': [], 'image/webp': [] }}
          disabled={busy}
          hint="PNG, JPEG or WebP."
          label="Replacement screenshot"
          onFiles={async (files) => {
            const file = files[0]
            if (!file) return
            setBusy(true)
            setError(null)
            try {
              setImage(await uploadStoryScreenshot(file, session.client))
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Upload failed.')
            } finally {
              setBusy(false)
            }
          }}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="mb-2 text-xs text-muted-foreground">
              Previous evidence · revision {story.source.revision}
            </p>
            {oldUrl ? (
              <img alt="Previous product evidence" src={oldUrl} className="rounded-lg border" />
            ) : null}
          </div>
          <div>
            {image ? (
              <FocusPicker src={image.url} value={focus} onChange={setFocus} />
            ) : (
              <p className="p-8 text-sm text-muted-foreground">
                Choose the new screenshot to compare.
              </p>
            )}
          </div>
        </div>
        {after ? <ChangeComparison before={before} after={after} storyId={storyId} /> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!after || busy}
            onClick={() => {
              if (after) session.commit(after)
              onClose()
            }}
          >
            Apply screenshot update
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EditStoryFocus({
  session,
  storyId,
  onClose,
}: {
  session: CreativeSetSession
  storyId: string
  onClose: () => void
}) {
  const story = session.snapshot().document.stories.find((story) => story.id === storyId)!
  const [focus, setFocus] = useState(story.focus)
  const [url, setUrl] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void fetchAssetUrl(session.client, story.source.src.slice(6))
      .then((url) => {
        if (active) setUrl(url)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [session, story.source.src])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>Focus the product evidence</DialogTitle>
        <DialogDescription>
          Updates linked focus details across this story. Locally adjusted focus details keep their
          override.
        </DialogDescription>
        {url ? <FocusPicker src={url} value={focus} onChange={setFocus} /> : null}
        {error ? <p role="alert">{error}</p> : null}
        <Button
          disabled={!url}
          onClick={() => {
            session.command({ type: 'focus', storyId, focus })
            onClose()
          }}
        >
          Apply focus to story
        </Button>
      </DialogContent>
    </Dialog>
  )
}

type Version = Awaited<
  ReturnType<CreativeSetSession['client']['creativeSet']['versions']['query']>
>[number]

export function SetVersionHistory({
  session,
  canEdit,
  onClose,
}: {
  session: CreativeSetSession
  canEdit: boolean
  onClose: () => void
}) {
  const [versions, setVersions] = useState<Version[]>([]),
    [selected, setSelected] = useState<{ id: string; document: CreativeSetDocument } | null>(null)
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void session.client.creativeSet.versions
      .query({ creativeSetId: session.record.id })
      .then((items) => {
        if (active) setVersions(items)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [session])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'History operation failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-5xl">
        <DialogTitle>Story Set history</DialogTitle>
        <DialogDescription>
          Restore creates a new revision and keeps the work it replaces.
        </DialogDescription>
        {canEdit ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void run(async () => {
                if (!(await session.save()))
                  throw new Error('Resolve the save conflict before naming a version.')
                await session.client.creativeSet.createVersion.mutate({
                  creativeSetId: session.record.id,
                  name,
                })
                setVersions(
                  await session.client.creativeSet.versions.query({
                    creativeSetId: session.record.id,
                  })
                )
                setName('')
              })
            }}
          >
            <Input
              aria-label="Version name"
              placeholder="Version name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
            />
            <Button disabled={busy || !name.trim()}>Save version</Button>
          </form>
        ) : null}
        <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">
          {versions.map((version) => (
            <Button
              variant={selected?.id === version.id ? 'secondary' : 'outline'}
              key={version.id}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await session.client.creativeSet.version.query({
                    creativeSetId: session.record.id,
                    versionId: version.id,
                  })
                  setSelected({ id: version.id, document: result.document })
                })
              }
            >
              {version.name ?? version.kind} · r{version.revision}
            </Button>
          ))}
        </div>
        {selected ? (
          <>
            <ChangeComparison before={session.snapshot().document} after={selected.document} />
            {canEdit ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!(await session.save()))
                      throw new Error('Resolve the save conflict before restoring.')
                    const record = await session.client.creativeSet.restoreVersion.mutate({
                      creativeSetId: session.record.id,
                      versionId: selected.id,
                      baseRevision: session.snapshot().revision,
                    })
                    session.acceptSaved(record)
                    onClose()
                  })
                }
              >
                Restore as a new revision
              </Button>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

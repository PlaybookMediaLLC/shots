'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { CanvasSession } from '@/lib/canvas/session'
import { artboardSize } from '@/lib/canvas/document'
import {
  canvasPdfFileName,
  canvasExportFormatSchema,
  exportSelection,
  packageArtboards,
  renderArtboard,
  type CanvasExportOrder,
  type RenderedArtboard,
} from '@/lib/canvas/export'
import { brandCommand } from '@/lib/canvas/brand'
import {
  buildRecipe,
  canvasRecipeSchema,
  CANVAS_RECIPES,
  type CanvasRecipe,
} from '@/lib/canvas/recipes'
import { useCanvasUi } from '@/lib/canvas/ui-store'
import { BRAND_CATEGORIES, type BrandCategory } from '@/lib/brand/apply'
import { brandKitLibrary, type BrandKit } from '@/lib/brand/kit'
import { downloadBlob } from '@/lib/creative-sets/delivery'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { RecipeForm } from './NewCanvas'
import type { CanvasActions } from './use-canvas-actions'

/** Which dialog or sheet is open. */
export const canvasDialogSchema = z.union([
  z.enum([
    'export',
    'history',
    'brand',
    'campaign',
    'mobile-artboards',
    'mobile-properties',
    'add-store',
  ]),
  z.templateLiteral(['recipe:', canvasRecipeSchema]),
])
/** One of {@link canvasDialogSchema}. */
export type CanvasDialog = z.infer<typeof canvasDialogSchema>

import { AddStoreGroupDialog } from './StoreGroups'

type Props = {
  dialog: CanvasDialog | null
  onClose: () => void
  session: CanvasSession
  canEdit: boolean
  flush: () => void
  actions: CanvasActions
}

/** The canvas's dialogs; each reads the session it acts on. */
export function CanvasDialogs(props: Props) {
  const { dialog } = props
  if (dialog === 'export') return <ExportDialog {...props} />
  if (dialog === 'history') return <HistoryDialog {...props} />
  if (dialog === 'brand') return <BrandDialog {...props} />
  if (dialog === 'campaign') return <HandoffDialog {...props} />
  if (dialog === 'add-store') return <AddStoreGroupDialog {...props} />
  if (dialog?.startsWith('recipe:')) {
    const recipe = canvasRecipeSchema.safeParse(dialog.slice('recipe:'.length))
    if (recipe.success) return <RecipeDialog {...props} recipe={recipe.data} />
  }
  return null
}

/** Save pending work first; exports and handoffs name an exact saved revision. */
async function saved(session: CanvasSession, flush: () => void, canEdit: boolean) {
  if (!canEdit) return true
  flush()
  return session.save()
}

type Row = { id: string; name: string; result?: RenderedArtboard; error?: string }

/** Export choices: the browser's file formats, or a selectable-text PDF printed on the server. */
const exportChoiceSchema = canvasExportFormatSchema.or(z.literal('pdf-text'))
type ExportChoice = z.infer<typeof exportChoiceSchema>

function ExportDialog({ onClose, session, canEdit, flush }: Props) {
  const document = session.snapshot().document
  const selection = useCanvasUi.getState().selection
  const [chosen, setChosen] = useState<string[]>(() =>
    selection.length ? selection : document.artboards.map((artboard) => artboard.id)
  )
  const [format, setFormat] = useState<ExportChoice>('png')
  const [printed, setPrinted] = useState<{ blob: Blob; fileName: string } | null>(null)
  const [scale, setScale] = useState<1 | 2 | 3>(1)
  const [order, setOrder] = useState<CanvasExportOrder>('reading')
  const [transparent, setTransparent] = useState(false)
  const [includeHidden, setIncludeHidden] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [revision, setRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [delivered, setDelivered] = useState(false)
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  async function render() {
    setBusy(true)
    setError(null)
    setDelivered(false)
    try {
      if (!(await saved(session, flush, canEdit)))
        throw new Error('Save the canvas before exporting. Resolve the save problem shown above.')
      const snapshot = session.snapshot()
      const items = exportSelection(snapshot.document, chosen, order)
      if (!items.length) throw new Error('Choose at least one artboard.')
      if (canEdit) {
        const versions = await session.client.canvas.versions.query({ canvasId: session.record.id })
        if (
          !versions.some(
            (version) => version.kind === 'named' && version.revision === snapshot.revision
          )
        )
          await session.client.canvas.createVersion.mutate({
            canvasId: session.record.id,
            name: `Delivery revision ${snapshot.revision}`,
            baseRevision: snapshot.revision,
          })
      }
      setRevision(snapshot.revision)
      const controller = new AbortController()
      abort.current = controller
      const next: Row[] = items.map((artboard) => ({ id: artboard.id, name: artboard.name }))
      setRows([...next])
      setPrinted(null)
      if (format === 'pdf-text') {
        // One server print: every page keeps real text and vector shapes.
        const response = await fetch(`/api/tenant/canvases/${session.record.id}/pdf`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ artboardIds: items.map((artboard) => artboard.id) }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const reason = await response
            .json()
            .then((body: { error?: { message?: string }; message?: string }) =>
              typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
            )
            .catch(() => null)
          throw new Error(reason ?? 'The PDF could not be printed.')
        }
        setPrinted({
          blob: await response.blob(),
          fileName: canvasPdfFileName(session.record.name, snapshot.revision),
        })
        return
      }
      for (const [index, artboard] of items.entries()) {
        try {
          const result = await renderArtboard(
            session.client,
            artboard,
            { canvasName: session.record.name, revision: snapshot.revision, index },
            { format, scale, order, transparent, includeHidden },
            controller.signal
          )
          next[index] = { ...next[index]!, result }
        } catch (failure) {
          if (controller.signal.aborted) return
          next[index] = {
            ...next[index]!,
            error: failure instanceof Error ? failure.message : 'Export failed.',
          }
        }
        setRows([...next])
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Export failed.')
    } finally {
      setBusy(false)
    }
  }

  const rendered = rows?.flatMap((row) => (row.result ? [row.result] : [])) ?? []
  const complete = Boolean(printed) || (Boolean(rows?.length) && rendered.length === rows!.length)

  async function download() {
    if (printed) {
      downloadBlob(printed.blob, printed.fileName)
      return
    }
    if (format === 'pdf-text') return
    try {
      const file = await packageArtboards(rendered, {
        format,
        canvasName: session.record.name,
        canvasId: session.record.id,
        revision: revision!,
      })
      downloadBlob(file.blob, file.fileName)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The download could not be prepared.')
    }
  }

  async function deliver() {
    setBusy(true)
    setError(null)
    try {
      const deliveries = []
      for (const item of rendered) {
        const asset = await saveExportToWorkspace({
          blob: item.blob,
          fileName: item.manifest.fileName,
          trpcClient: session.client,
        })
        deliveries.push({ ...item.manifest, asset: `asset:${asset.assetId}` })
      }
      const next = structuredClone(session.snapshot().document)
      const known = new Set(next.deliveries.map((delivery) => delivery.id))
      next.deliveries.push(...deliveries.filter((delivery) => !known.has(delivery.id)))
      session.commit(next, false)
      if (!(await session.save()))
        throw new Error(
          'Files uploaded, but the canvas did not save their delivery record. Retry to reuse them.'
        )
      setDelivered(true)
      toast.success('Saved to workspace assets. You can now send these to a campaign.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Saving to the workspace failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="flex max-h-[90dvh] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
        <DialogTitle>Export artboards</DialogTitle>
        <DialogDescription>
          Each artboard renders at its exact size from the saved canvas. A missing image or font, or
          text that overflows its box or overlaps other text, stops that file with a message instead
          of exporting something wrong.
        </DialogDescription>
        {!rows ? (
          <div className="flex min-h-0 min-w-0 flex-col gap-4">
            <div className="grid min-h-0 min-w-0 gap-4 overflow-y-auto">
              <fieldset className="grid min-w-0 max-h-56 gap-1 overflow-x-hidden overflow-y-auto rounded-md border p-2">
                <legend className="px-1 text-xs text-muted-foreground">Artboards</legend>
                <Label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.length === document.artboards.length}
                    onCheckedChange={(checked) =>
                      setChosen(
                        checked === true ? document.artboards.map((artboard) => artboard.id) : []
                      )
                    }
                  />
                  All ({document.artboards.length})
                </Label>
                {document.artboards.map((artboard) => (
                  <Label key={artboard.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      checked={chosen.includes(artboard.id)}
                      onCheckedChange={(checked) =>
                        setChosen((previous) =>
                          checked === true
                            ? [...previous, artboard.id]
                            : previous.filter((id) => id !== artboard.id)
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate" title={artboard.name}>
                      {artboard.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {artboardSize(artboard).width}×{artboardSize(artboard).height}
                    </span>
                  </Label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-3">
                <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                  Format
                  <Select
                    value={format}
                    onValueChange={(value) => setFormat(exportChoiceSchema.parse(value))}
                  >
                    <SelectTrigger
                      aria-label="Export format"
                      className="min-w-0 w-full text-foreground [&>span]:truncate"
                    >
                      <SelectValue>
                        {format === 'pdf-text'
                          ? 'PDF · vector'
                          : format === 'pdf'
                            ? 'PDF · image'
                            : format.toUpperCase()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="png">PNG</SelectItem>
                      <SelectItem value="jpeg">JPEG</SelectItem>
                      <SelectItem value="webp">WebP</SelectItem>
                      <SelectItem value="pdf">PDF (one image page per artboard)</SelectItem>
                      <SelectItem value="pdf-text">
                        PDF · selectable text and vector shapes
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                  Scale
                  <Select
                    value={String(scale)}
                    onValueChange={(value) => setScale(value === '3' ? 3 : value === '2' ? 2 : 1)}
                  >
                    <SelectTrigger
                      aria-label="Export scale"
                      disabled={format === 'pdf-text'}
                      className="min-w-0 w-full text-foreground [&>span]:truncate"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1× (exact size)</SelectItem>
                      <SelectItem value="2">2×</SelectItem>
                      <SelectItem value="3">3×</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="grid min-w-0 gap-1 text-xs text-muted-foreground">
                  Order
                  <Select
                    value={order}
                    onValueChange={(value) => setOrder(value === 'layers' ? 'layers' : 'reading')}
                  >
                    <SelectTrigger
                      aria-label="Export order"
                      className="min-w-0 w-full text-foreground [&>span]:truncate"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="reading">Board reading order</SelectItem>
                      <SelectItem value="layers">Artboard list order</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <Label className="flex items-center gap-2">
                  <Checkbox
                    checked={transparent}
                    disabled={format !== 'png' && format !== 'webp'}
                    onCheckedChange={(checked) => setTransparent(checked === true)}
                  />
                  Transparent background
                </Label>
                <Label className="flex items-center gap-2">
                  <Checkbox
                    checked={includeHidden}
                    disabled={format === 'pdf-text'}
                    onCheckedChange={(checked) => setIncludeHidden(checked === true)}
                  />
                  Include hidden layers
                </Label>
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={busy || !chosen.length} onClick={() => void render()}>
                {busy ? 'Preparing…' : `Render ${chosen.length}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            <p className="shrink-0 text-xs text-muted-foreground">
              Files from revision {revision}. Current canvas revision: {session.snapshot().revision}
              .
            </p>
            <div className="min-h-0 min-w-0 overflow-y-auto">
              <ul aria-label="Rendered artboards" className="grid min-w-0 gap-1">
                {rows.map((row) => (
                  <li
                    key={row.id}
                    className="grid min-w-0 gap-2 rounded-md border px-2 py-1.5 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate" title={row.name}>
                        {row.name}
                      </span>
                      {row.result ? (
                        <span className="text-xs text-emerald-600">
                          {row.result.width}×{row.result.height} ·{' '}
                          {(row.result.blob.size / 1024).toFixed(0)} KB
                        </span>
                      ) : row.error ? (
                        <span
                          role="alert"
                          className="max-w-[60%] text-right text-xs text-destructive"
                        >
                          {row.error}
                        </span>
                      ) : printed ? (
                        <span className="text-xs text-emerald-600">On its own page</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {format === 'pdf-text' && error ? 'Not printed' : 'Rendering…'}
                        </span>
                      )}
                    </div>
                    {row.result ? <ExportPreview blob={row.result.blob} name={row.name} /> : null}
                  </li>
                ))}
              </ul>
              {printed ? <ExportPreview blob={printed.blob} name="PDF preview" /> : null}
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setRows(null)
                  setPrinted(null)
                }}
                disabled={busy}
              >
                Change settings
              </Button>
              {canEdit ? (
                <Button
                  variant="outline"
                  disabled={
                    !complete || busy || delivered || format === 'pdf' || format === 'pdf-text'
                  }
                  onClick={() => void deliver()}
                >
                  {delivered ? 'Saved to workspace' : 'Save to workspace'}
                </Button>
              ) : null}
              <Button disabled={!complete || busy} onClick={() => void download()}>
                {format === 'pdf' || format === 'pdf-text'
                  ? 'Download PDF'
                  : rendered.length > 1
                    ? 'Download ZIP'
                    : 'Download'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ExportPreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  if (!url) return null
  return blob.type === 'application/pdf' ? (
    <iframe title={name} src={url} className="h-72 w-full rounded border" />
  ) : (
    <img alt={`Preview of ${name}`} src={url} className="max-h-60 w-full rounded object-contain" />
  )
}

type Version = Awaited<ReturnType<CanvasSession['client']['canvas']['versions']['query']>>[number]

function HistoryDialog({ onClose, session, canEdit, flush }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [restoring, setRestoring] = useState<Version | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    session.client.canvas.versions.query({ canvasId: session.record.id }).then(
      (list) => {
        if (active) setVersions(list)
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Could not load the history.')
      }
    )
    return () => {
      active = false
    }
  }, [session, refresh])
  async function attempt(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setRefresh((value) => value + 1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogTitle>Version history</DialogTitle>
        <DialogDescription>
          Autosaves are checkpointed every ten minutes. Named versions are kept. Restoring creates a
          new revision and keeps the one it replaces.
        </DialogDescription>
        {canEdit ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (!name.trim()) return
              void attempt(async () => {
                if (!(await saved(session, flush, canEdit)))
                  throw new Error('Save the canvas before naming a version.')
                await session.client.canvas.createVersion.mutate({
                  canvasId: session.record.id,
                  name: name.trim(),
                  baseRevision: session.snapshot().revision,
                })
                setName('')
              })
            }}
          >
            <Input
              aria-label="Version name"
              placeholder="Name this version"
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim()}>
              Save version
            </Button>
          </form>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {!versions ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {restoring ? (
          <div
            className="grid gap-3 rounded-md border p-3"
            role="group"
            aria-label="Confirm restore"
          >
            <p className="text-sm">
              Restore revision {restoring.revision}? Your current work will be saved in history
              first.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setRestoring(null)}>
                Cancel restore
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void attempt(async () => {
                    if (!(await saved(session, flush, canEdit)))
                      throw new Error('Save the canvas before restoring.')
                    const record = await session.client.canvas.restoreVersion.mutate({
                      canvasId: session.record.id,
                      versionId: restoring.id,
                      baseRevision: session.snapshot().revision,
                    })
                    useCanvasUi.getState().activate(null)
                    session.acceptSaved(record)
                    toast.success(
                      `Restored revision ${restoring.revision} as revision ${record.revision}.`
                    )
                    setRestoring(null)
                  })
                }
              >
                Confirm restore
              </Button>
            </div>
          </div>
        ) : null}
        <ul aria-label="Versions" className="grid gap-1">
          {versions
            ?.toSorted((a, b) => Number(isDeliveryVersion(a)) - Number(isDeliveryVersion(b)))
            .map((version) => (
              <li
                key={version.id}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${version.kind === 'named' && !isDeliveryVersion(version) ? 'border-sky-500/40 bg-sky-500/5' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {version.name ?? (version.kind === 'autosave' ? 'Autosave' : version.kind)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isDeliveryVersion(version)
                      ? 'Delivery checkpoint · '
                      : version.kind === 'named'
                        ? 'Named version · '
                        : ''}
                    Revision {version.revision} · {version.createdAt.toLocaleString()}
                    {version.createdByName ? ` · ${version.createdByName}` : ''}
                  </p>
                </div>
                {canEdit && version.revision !== session.snapshot().revision ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || Boolean(restoring)}
                    onClick={() => setRestoring(version)}
                  >
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

function isDeliveryVersion(version: Version) {
  return version.kind === 'named' && /^Deliver(?:y|ed) revision \d+$/.test(version.name ?? '')
}

function BrandDialog({ onClose, session, actions }: Props) {
  const [kits, setKits] = useState<BrandKit[] | null>(null)
  const [kitId, setKitId] = useState<string>('')
  const [categories, setCategories] = useState<BrandCategory[]>([...BRAND_CATEGORIES])
  const [reset, setReset] = useState(false)
  const selection = useCanvasUi.getState().selection
  const [scope, setScope] = useState<'selection' | 'all'>(selection.length ? 'selection' : 'all')
  useEffect(() => {
    let active = true
    session.client.brandKit.list.query().then(
      ({ brandKits }) => {
        if (!active) return
        const library = brandKitLibrary(brandKits)
        setKits(library)
        setKitId(library[0]?.id ?? '')
      },
      () => {
        if (active) setKits([])
      }
    )
    return () => {
      active = false
    }
  }, [session])
  const kit = kits?.find((item) => item.id === kitId)
  const ids =
    scope === 'selection'
      ? selection
      : session.snapshot().document.artboards.map((artboard) => artboard.id)
  const preview = kit
    ? brandCommand(session.snapshot().document, ids, kit, categories, { resetOverrides: reset })
    : null
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-md">
        <DialogTitle>Apply a brand kit</DialogTitle>
        <DialogDescription>
          Colours, fonts, background, frame and logo come from the kit. Anything you changed by hand
          since the kit was last applied stays yours unless you reset it.
        </DialogDescription>
        {kits && !kits.length ? (
          <p className="text-sm text-muted-foreground">
            No brand kits yet.{' '}
            <Link className="underline" href="/settings/brand-kit">
              Create one in Settings
            </Link>
            .
          </p>
        ) : null}
        {kits?.length ? (
          <div className="grid gap-3">
            <Select value={kitId} onValueChange={setKitId}>
              <SelectTrigger aria-label="Visual brand kit" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kits.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · v{item.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <RadioGroup
              value={scope}
              onValueChange={(value) => setScope(value === 'all' ? 'all' : 'selection')}
              className="flex gap-3 text-sm"
            >
              <Label className="flex items-center gap-2">
                <RadioGroupItem value="selection" disabled={!selection.length} />
                Selected ({selection.length})
              </Label>
              <Label className="flex items-center gap-2">
                <RadioGroupItem value="all" />
                All artboards
              </Label>
            </RadioGroup>
            <fieldset className="flex flex-wrap gap-3 text-sm">
              {BRAND_CATEGORIES.map((category) => (
                <Label key={category} className="flex items-center gap-1.5 capitalize">
                  <Checkbox
                    checked={categories.includes(category)}
                    onCheckedChange={(checked) =>
                      setCategories((previous) =>
                        checked === true
                          ? [...previous, category]
                          : previous.filter((item) => item !== category)
                      )
                    }
                  />
                  {category}
                </Label>
              ))}
            </fieldset>
            <Label className="flex items-center gap-2 text-sm">
              <Checkbox checked={reset} onCheckedChange={(checked) => setReset(checked === true)} />
              Reset my overrides to the kit
            </Label>
            {preview && preview.keptOverrides > 0 && !reset ? (
              <p className="text-xs text-muted-foreground">
                {preview.keptOverrides} property changes you made will be kept.
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={!preview?.command || !categories.length}
                onClick={() => {
                  if (preview?.command && actions.run(preview.command)) {
                    toast.success(
                      `Applied ${kit!.name} to ${ids.length} artboard${ids.length === 1 ? '' : 's'}. Undo is available.`
                    )
                    onClose()
                  }
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const channelSchema = z.enum(['x', 'linkedin', 'instagram'])

function HandoffDialog({ onClose, session, flush, canEdit }: Props) {
  const document = session.snapshot().document
  const deliveries = document.deliveries.filter((delivery) => delivery.asset)
  const [deliveryId, setDeliveryId] = useState(deliveries.at(-1)?.id ?? '')
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [channel, setChannel] = useState<z.infer<typeof channelSchema>>('linkedin')
  const [copy, setCopy] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ campaignId: string } | null>(null)
  useEffect(() => {
    let active = true
    session.client.campaign.list.query().then(
      ({ campaigns }) => {
        if (!active) return
        setCampaigns(campaigns)
        setCampaignId(document.context.campaignId ?? campaigns[0]?.id ?? '')
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [session, document.context.campaignId])
  const name = (id: string) =>
    document.artboards.find((artboard) => artboard.id === id)?.name ?? 'Removed artboard'
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Send to a campaign for review</DialogTitle>
        <DialogDescription>
          Attaches one delivered file as a new draft. It goes through the campaign&apos;s normal
          review and approval; nothing is published from here, and earlier approved or scheduled
          posts are not changed.
        </DialogDescription>
        {!deliveries.length ? (
          <p className="text-sm text-muted-foreground">
            Nothing delivered yet. Export, then choose <strong>Save to workspace</strong>.
          </p>
        ) : result ? (
          <div className="grid gap-2 text-sm">
            <p>Attached as a draft for review.</p>
            <Link className="underline" href={`/campaigns/${result.campaignId}`}>
              Open the campaign
            </Link>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void (async () => {
                setBusy(true)
                setError(null)
                try {
                  if (!(await saved(session, flush, canEdit)))
                    throw new Error('Save the canvas first.')
                  const attached = await session.client.canvas.attachCampaign.mutate({
                    canvasId: session.record.id,
                    baseRevision: session.snapshot().revision,
                    deliveryId,
                    campaignId,
                    channel,
                    copy: copy.trim(),
                  })
                  setResult({ campaignId: attached.campaignId })
                } catch (failure) {
                  setError(failure instanceof Error ? failure.message : 'The handoff failed.')
                } finally {
                  setBusy(false)
                }
              })()
            }}
          >
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Delivered file
              <Select value={deliveryId} onValueChange={setDeliveryId}>
                <SelectTrigger aria-label="Delivered file" className="w-full text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {deliveries.map((delivery) => (
                    <SelectItem key={delivery.id} value={delivery.id}>
                      {name(delivery.outputId)} · source revision {delivery.revision}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Campaign
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger aria-label="Campaign" className="w-full text-foreground">
                  <SelectValue
                    placeholder={campaigns.length ? 'Choose a campaign' : 'No campaigns available'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((campaign) => (
                    <SelectItem key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Channel
              <Select
                value={channel}
                onValueChange={(value) => setChannel(channelSchema.parse(value))}
              >
                <SelectTrigger aria-label="Channel" className="w-full text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="linkedin">LinkedIn</SelectItem>
                  <SelectItem value="x">X</SelectItem>
                  <SelectItem value="instagram">Instagram</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Post copy
              <Textarea
                aria-label="Post copy"
                value={copy}
                rows={4}
                maxLength={4000}
                onChange={(event) => setCopy(event.target.value)}
              />
            </Label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !campaignId || !deliveryId || !copy.trim()}>
                Attach for review
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RecipeDialog({ onClose, actions, recipe }: Props & { recipe: CanvasRecipe }) {
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogTitle>{CANVAS_RECIPES[recipe].name}</DialogTitle>
        <DialogDescription>
          {CANVAS_RECIPES[recipe].artboards}. Every layer stays editable.
        </DialogDescription>
        <RecipeForm
          recipe={recipe}
          submitLabel="Add to canvas"
          onCreate={(input) => {
            actions.addArtboards(buildRecipe(recipe, input))
            onClose()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

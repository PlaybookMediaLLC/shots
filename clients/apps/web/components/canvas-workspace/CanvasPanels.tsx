'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { CanvasSession, CanvasSessionState } from '@/lib/canvas/session'
import { artboardRect, artboardSize, type Artboard } from '@/lib/canvas/document'
import { alignModeSchema, type AlignMode } from '@/lib/canvas/layout'
import {
  alternativeLayouts,
  ARTBOARD_PRESETS,
  artboardPresetSchema,
  CANVAS_RECIPES,
  canvasRecipeSchema,
  type ArtboardPreset,
} from '@/lib/canvas/recipes'
import {
  BLOCK_GROUPS,
  blockChanges,
  layerBlockSchema,
  SCREEN_BLOCK_CODE,
  screenBlockSchema,
  type LayerBlock,
  type ScreenBlock,
} from '@/lib/canvas/blocks'
import { leftTabSchema, useCanvasUi } from '@/lib/canvas/ui-store'
import { applyDesignChanges } from '@/lib/design/apply'
import { exportDesignDocument } from '@/lib/design/export'
import {
  addCodeScreen,
  setMainFrame,
  setScreensFrame,
  showMainOnDevice,
  updateScreenCode,
} from '@/lib/frames/commands'
import { useImageStore } from '@/lib/store'
import { validateImageContents } from '@/lib/editor/import-images'
import { cn } from '@/lib/utils'
import { useTRPCClient } from '@/lib/trpc/react'
import { screenshotFromAsset, screenshotFromUrl } from '@/lib/canvas/create'
import { ProductContextPanel } from './ProductContextPanel'
import type { CanvasActions } from './use-canvas-actions'
import type { CanvasDialog } from './CanvasDialogs'
import type { LayerActions } from './use-layer-actions'
import { ComponentList, LayerSelectionPanel } from './LayerPanel'
import { StoreGroupPanel } from './StoreGroups'

const ComposePanel = dynamic(
  () => import('@/components/editor/panels/EditorPanel').then((module) => module.ComposePanel),
  {
    ssr: false,
    loading: () => <p className="p-4 text-xs text-muted-foreground">Loading design tools…</p>,
  }
)
const InspectorPanel = dynamic(
  () => import('@/components/editor/panels/EditorPanel').then((module) => module.InspectorPanel),
  {
    ssr: false,
    loading: () => <p className="p-4 text-xs text-muted-foreground">Loading properties…</p>,
  }
)

/** What every panel receives. */
export type PanelProps = {
  session: CanvasSession
  state: CanvasSessionState
  actions: CanvasActions
  canEdit: boolean
  /** True when the native editor has an artboard open and ready. */
  editing: boolean
  onDialog: (dialog: CanvasDialog) => void
  layerActions: LayerActions
}

const section = 'space-y-2 border-b px-4 py-4'
const heading = 'text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground'

/** Insert, artboards and the native compose panel. */
export function LeftPanel(props: PanelProps & { only?: 'artboards' }) {
  const tab = useCanvasUi((ui) => ui.leftTab)
  const setTab = useCanvasUi((ui) => ui.setLeftTab)
  if (props.only === 'artboards') return <ArtboardList {...props} />
  return (
    <Tabs
      value={tab === 'design' && !props.editing ? 'insert' : tab}
      onValueChange={(value) => {
        const parsed = leftTabSchema.safeParse(value)
        if (parsed.success) setTab(parsed.data)
      }}
      className="flex h-full flex-col gap-0"
    >
      <TabsList aria-label="Canvas tools" className="m-2 grid grid-cols-3">
        <TabsTrigger value="insert">Insert</TabsTrigger>
        <TabsTrigger value="artboards">Artboards</TabsTrigger>
        <TabsTrigger
          value="design"
          disabled={!props.editing}
          title={props.editing ? undefined : 'Edit an artboard to use the design tools'}
        >
          Design
        </TabsTrigger>
      </TabsList>
      <TabsContent value="insert" className="min-h-0 flex-1 overflow-y-auto">
        <InsertPanel {...props} />
      </TabsContent>
      <TabsContent value="artboards" className="min-h-0 flex-1 overflow-y-auto">
        <ArtboardList {...props} />
      </TabsContent>
      <TabsContent value="design" className="min-h-0 flex-1 overflow-y-auto">
        {props.editing ? <ComposePanel /> : null}
      </TabsContent>
    </Tabs>
  )
}

/** Add a block to the open artboard as native layers; the native bridge records it as one step. */
async function insertBlock(block: LayerBlock | ScreenBlock, flush: () => void) {
  const layer = layerBlockSchema.safeParse(block)
  if (layer.success) {
    await applyDesignChanges(
      blockChanges(layer.data, exportDesignDocument({ keepLocalSources: true })),
      (src) => src
    )
    flush()
    return
  }
  const screen = screenBlockSchema.parse(block)
  if (screen === 'browser-window' || screen === 'device') {
    if (!useImageStore.getState().uploadedImageUrl)
      throw new Error('Add a screenshot to this artboard first, then frame it.')
    if (screen === 'browser-window') setMainFrame('browser')
    else await showMainOnDevice('iphone-17-pro-front')
    flush()
    return
  }
  const sample = SCREEN_BLOCK_CODE[screen]
  const id = await addCodeScreen(sample.code)
  if (!id) throw new Error('This artboard already holds the most screens it can (6).')
  const terminal = screen === 'terminal'
  setScreensFrame([id], {
    kind: 'window',
    chrome: {
      title: sample.title,
      window: terminal ? 'terminal-macos' : 'macos',
      appearance: 'dark',
    },
  })
  updateScreenCode(id, {
    language: terminal ? 'shell-session' : screen === 'api-response' ? 'json' : 'typescript',
    lineNumbers: !terminal,
  })
  flush()
}

function InsertPanel({
  session,
  state,
  actions,
  canEdit,
  editing,
  onDialog,
  layerActions,
}: PanelProps) {
  const [width, setWidth] = useState('1600')
  const [height, setHeight] = useState('900')
  const [busy, setBusy] = useState(false)
  async function block(id: LayerBlock | ScreenBlock) {
    setBusy(true)
    try {
      await insertBlock(id, actions.flush)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That block could not be added.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <section aria-label="Artboard sizes" className={section}>
        <h2 className={heading}>Artboard</h2>
        <div className="grid grid-cols-2 gap-1.5">
          {artboardPresetSchema.options.map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant="outline"
              disabled={!canEdit}
              className="h-auto justify-start whitespace-normal py-1.5 text-left text-xs"
              onClick={() => actions.addPreset(preset)}
            >
              {ARTBOARD_PRESETS[preset].name}
            </Button>
          ))}
        </div>
        <form
          className="flex items-end gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            const w = Math.round(Number(width))
            const h = Math.round(Number(height))
            if (w >= 16 && h >= 16 && w <= 8192 && h <= 8192)
              actions.addPreset({ width: w, height: h })
            else toast.error('Use a size from 16 to 8192 pixels.')
          }}
        >
          <Label className="grid gap-1 text-[11px] text-muted-foreground">
            W
            <Input
              aria-label="Custom width"
              inputMode="numeric"
              value={width}
              onChange={(event) => setWidth(event.target.value)}
              className="h-8 w-20"
            />
          </Label>
          <Label className="grid gap-1 text-[11px] text-muted-foreground">
            H
            <Input
              aria-label="Custom height"
              inputMode="numeric"
              value={height}
              onChange={(event) => setHeight(event.target.value)}
              className="h-8 w-20"
            />
          </Label>
          <Button size="sm" type="submit" variant="secondary" disabled={!canEdit}>
            Add
          </Button>
        </form>
      </section>
      <section aria-label="Templates" className={section}>
        <h2 className={heading}>Templates</h2>
        <div className="grid gap-1">
          {canvasRecipeSchema.options.map((recipe) => (
            <Button
              variant="custom"
              size={null}
              key={recipe}
              type="button"
              disabled={!canEdit}
              onClick={() => onDialog(`recipe:${recipe}`)}
              className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/[0.05] disabled:opacity-50"
            >
              <span className="block">{CANVAS_RECIPES[recipe].name}</span>
              <span className="block text-[11px] text-muted-foreground">
                {CANVAS_RECIPES[recipe].artboards}
              </span>
            </Button>
          ))}
          <Button
            variant="custom"
            size={null}
            type="button"
            disabled={!canEdit}
            onClick={() => onDialog('add-store')}
            className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/[0.05] disabled:opacity-50"
          >
            <span className="block">App Store screenshots</span>
            <span className="block text-[11px] text-muted-foreground">
              A store screenshot group · every store size and language
            </span>
          </Button>
          <Link
            href="/store-screenshots"
            className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-foreground/[0.05]"
          >
            Open the screenshots studio ↗
          </Link>
        </div>
      </section>
      <section aria-label="Components" className={section}>
        <h2 className={heading}>Components</h2>
        <ComponentList
          session={session}
          components={state.document.components}
          actions={layerActions}
          editing={editing}
          canEdit={canEdit}
        />
      </section>
      <section aria-label="Blocks" className={section}>
        <h2 className={heading}>Blocks</h2>
        {!editing ? (
          <p className="text-xs text-muted-foreground">
            Double-click an artboard (or press Enter) to add blocks to it.
          </p>
        ) : null}
        {BLOCK_GROUPS.map((group) => (
          <div key={group.title} className="space-y-1">
            <h3 className="pt-1 text-[11px] text-muted-foreground">{group.title}</h3>
            <div className="flex flex-wrap gap-1">
              {group.blocks.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  disabled={!canEdit || !editing || busy}
                  onClick={() => void block(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <ScreenshotButtons disabled={!canEdit || !editing} />
      </section>
    </div>
  )
}

/** Replace the open artboard's screenshot, or add an image layer, through the editor's own actions. */
function ScreenshotButtons({ disabled }: { disabled: boolean }) {
  const pick = (onFile: (file: File) => void) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const problem = await validateImageContents(file)
      if (problem) toast.error(problem)
      else onFile(file)
    }
    input.click()
  }
  return (
    <div className="space-y-1">
      <h3 className="pt-1 text-[11px] text-muted-foreground">Images</h3>
      <div className="flex flex-wrap gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() =>
            pick((file) =>
              useImageStore.getState().replaceTemplateMedia(URL.createObjectURL(file), file.name)
            )
          }
        >
          Replace screenshot
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          onClick={() =>
            pick((file) => {
              const state = useImageStore.getState()
              const canvas = state.canvasDimensions ?? { canvasW: 800, canvasH: 600 }
              state.addImageOverlay({
                src: URL.createObjectURL(file),
                position: { x: canvas.canvasW / 2, y: canvas.canvasH / 2 },
                size: Math.round(canvas.canvasW * 0.3),
                rotation: 0,
                opacity: 1,
                flipX: false,
                flipY: false,
                isVisible: true,
                isCustom: true,
              })
            })
          }
        >
          Image or logo
        </Button>
      </div>
    </div>
  )
}

/** Every artboard, front-most first, with its size and where it came from. */
function ArtboardList({ state, actions, canEdit }: PanelProps) {
  const selection = useCanvasUi((ui) => ui.selection)
  const activeId = useCanvasUi((ui) => ui.activeId)
  const select = useCanvasUi((ui) => ui.select)
  const toggle = useCanvasUi((ui) => ui.toggle)
  const ordered = [...state.document.artboards].reverse()
  if (!ordered.length) return <p className="p-4 text-sm text-muted-foreground">No artboards yet.</p>
  return (
    <ul aria-label="Artboards" className="grid gap-0.5 p-2">
      {ordered.map((artboard) => {
        const size = artboardSize(artboard)
        const selected = selection.includes(artboard.id)
        return (
          <li key={artboard.id}>
            <Button
              variant="custom"
              size={null}
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={(event) => {
                if (event.shiftKey || event.metaKey) toggle(artboard.id)
                else {
                  select([artboard.id])
                  actions.focus(artboardRect(artboard), 1)
                }
              }}
              onDoubleClick={() => canEdit && actions.edit(artboard.id)}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                selected ? 'bg-sky-500/10 text-foreground' : 'hover:bg-foreground/[0.04]'
              )}
            >
              <span className="min-w-0 flex-1 truncate">{artboard.name}</span>
              {artboard.id === activeId ? (
                <span className="text-[10px] text-sky-600">Editing</span>
              ) : null}
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {size.width}×{size.height}
              </span>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  top: 'Top',
  middle: 'Middle',
  bottom: 'Bottom',
}

/** Properties of the selection, the open artboard, or the canvas. */
export function RightPanel(props: PanelProps) {
  const { state, actions, canEdit, editing, onDialog } = props
  const selection = useCanvasUi((ui) => ui.selection)
  const activeId = useCanvasUi((ui) => ui.activeId)
  const layers = useCanvasUi((ui) => ui.layers)
  const storeSelection = useCanvasUi((ui) => ui.storeSelection)
  const chosenStore = state.document.storeGroups.find((item) => item.group.id === storeSelection)
  const chosen = state.document.artboards.filter((artboard) => selection.includes(artboard.id))
  const active = state.document.artboards.find((artboard) => artboard.id === activeId)
  if (active && editing)
    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui-lg font-medium">{active.name}</p>
            <p className="text-[11px] text-muted-foreground">
              {artboardSize(active).width} × {artboardSize(active).height} · editing
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => actions.exitEdit()}>
            Done
          </Button>
        </div>
        {layers.length ? (
          <LayerSelectionPanel
            artboard={active}
            components={state.document.components}
            actions={props.layerActions}
            canEdit={canEdit}
          />
        ) : (
          <InspectorPanel />
        )}
        <ProductContextPanel {...props} artboard={active} />
      </div>
    )
  if (chosenStore)
    return (
      <StoreGroupPanel
        key={chosenStore.group.id}
        session={props.session}
        item={chosenStore}
        canEdit={canEdit}
      />
    )
  if (chosen.length === 1) return <ArtboardInspector {...props} artboard={chosen[0]!} />
  if (chosen.length > 1)
    return (
      <div>
        <section className={section}>
          <h2 className="text-ui-lg font-medium">{chosen.length} artboards</h2>
          <h3 className={heading}>Align</h3>
          <div className="grid grid-cols-3 gap-1">
            {alignModeSchema.options.map((mode) => (
              <Button
                key={mode}
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={!canEdit}
                onClick={() => actions.align(mode)}
              >
                {ALIGN_LABELS[mode]}
              </Button>
            ))}
          </div>
          <h3 className={heading}>Distribute</h3>
          <div className="grid grid-cols-3 gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canEdit || chosen.length < 3}
              onClick={() => actions.distribute('horizontal')}
            >
              Across
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canEdit || chosen.length < 3}
              onClick={() => actions.distribute('vertical')}
            >
              Down
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canEdit}
              onClick={() => actions.tidy()}
            >
              Tidy
            </Button>
          </div>
        </section>
        <section className={section}>
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => actions.duplicate()}
            >
              Duplicate
            </Button>
            <FormatsButton actions={actions} ids={selection} disabled={!canEdit} />
            <Button size="sm" variant="outline" onClick={() => onDialog('export')}>
              Export {chosen.length}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={!canEdit}
              onClick={() => actions.remove()}
            >
              Delete
            </Button>
          </div>
        </section>
      </div>
    )
  return (
    <div>
      <section className={section}>
        <h2 className="text-ui-lg font-medium">Canvas</h2>
        <p className="text-xs text-muted-foreground">
          {state.document.artboards.length} artboard
          {state.document.artboards.length === 1 ? '' : 's'} · revision {state.revision}
        </p>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => actions.fitAll()}>
            Fit all
          </Button>
          <Button size="sm" variant="outline" disabled={!canEdit} onClick={() => actions.tidy()}>
            Tidy up
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Select an artboard to change its size or export it. Double-click one to edit its layers.
        </p>
      </section>
      <ProductContextPanel {...props} artboard={null} />
    </div>
  )
}

function FormatsButton({
  actions,
  ids,
  disabled,
}: {
  actions: CanvasActions
  ids: string[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<ArtboardPreset[]>([])
  if (!open)
    return (
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Create formats…
      </Button>
    )
  return (
    <fieldset className="mt-2 grid w-full gap-1 rounded-md border p-2">
      <legend className="px-1 text-xs text-muted-foreground">
        Adapt to sizes (laid out again, not stretched)
      </legend>
      {artboardPresetSchema.options.map((preset) => (
        <Label key={preset} className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={chosen.includes(preset)}
            onCheckedChange={(checked) =>
              setChosen((previous) =>
                checked === true
                  ? [...previous, preset]
                  : previous.filter((item) => item !== preset)
              )
            }
          />
          {ARTBOARD_PRESETS[preset].name}
        </Label>
      ))}
      <div className="flex gap-1 pt-1">
        <Button
          size="sm"
          disabled={!chosen.length}
          onClick={() => {
            actions.adaptTo(ids, chosen)
            setOpen(false)
            setChosen([])
          }}
        >
          Create {chosen.length || ''}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </fieldset>
  )
}

/** New artboards that arrange this screenshot and copy differently; the original is untouched. */
function AlternativesButton({
  artboard,
  actions,
  disabled,
}: {
  artboard: Artboard
  actions: CanvasActions
  disabled: boolean
}) {
  const client = useTRPCClient()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled || busy}
      title="Adds new artboards beside this one. Nothing here is overwritten."
      onClick={async () => {
        setBusy(true)
        try {
          const src = artboard.document.image.src!
          const screenshot = src.startsWith('asset:')
            ? await screenshotFromAsset(
                client,
                src.slice('asset:'.length),
                artboard.document.image.name ?? 'Screenshot'
              )
            : await screenshotFromUrl(src, artboard.document.image.name ?? 'Screenshot')
          actions.addArtboards(alternativeLayouts(artboard, screenshot))
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'The screenshot could not be read.')
        } finally {
          setBusy(false)
        }
      }}
    >
      Alternative layouts
    </Button>
  )
}

function ArtboardInspector(props: PanelProps & { artboard: Artboard }) {
  const { artboard, actions, canEdit, onDialog } = props
  const size = artboardSize(artboard)
  const [draft, setDraft] = useState({
    id: artboard.id,
    width: String(size.width),
    height: String(size.height),
  })
  const current =
    draft.id === artboard.id
      ? draft
      : { id: artboard.id, width: String(size.width), height: String(size.height) }
  const preset = artboardPresetSchema.options.find(
    (option) =>
      ARTBOARD_PRESETS[option].width === size.width &&
      ARTBOARD_PRESETS[option].height === size.height
  )
  return (
    <div>
      <section className={section} aria-label="Artboard">
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Name
          <Input
            key={`${artboard.id}:${artboard.name}`}
            defaultValue={artboard.name}
            maxLength={120}
            disabled={!canEdit}
            aria-label="Artboard name"
            onBlur={(event) => {
              const name = event.currentTarget.value.trim()
              if (!name) {
                event.currentTarget.value = artboard.name
                toast.error('Enter an artboard name. The previous name has been kept.')
              } else if (name !== artboard.name) actions.rename(artboard.id, name)
              else event.currentTarget.value = name
            }}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {(['x', 'y'] as const).map((axis) => (
            <Label key={axis} className="grid gap-1 text-xs text-muted-foreground">
              {axis.toUpperCase()}
              <Input
                key={`${artboard.id}:${axis}:${artboard[axis]}`}
                defaultValue={Math.round(artboard[axis])}
                inputMode="numeric"
                disabled={!canEdit}
                aria-label={`Artboard ${axis.toUpperCase()}`}
                onBlur={(event) => {
                  const value = Number(event.target.value)
                  if (!event.currentTarget.value.trim() || !Number.isFinite(value)) {
                    event.currentTarget.value = String(Math.round(artboard[axis]))
                    toast.error('Enter a number. The previous position has been kept.')
                  } else if (value !== artboard[axis])
                    actions.move([
                      {
                        id: artboard.id,
                        x: axis === 'x' ? value : artboard.x,
                        y: axis === 'y' ? value : artboard.y,
                      },
                    ])
                }}
                onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              />
            </Label>
          ))}
        </div>
      </section>
      <section className={section} aria-label="Export size">
        <h2 className={heading}>Size</h2>
        <Select
          value={preset ?? 'custom'}
          disabled={!canEdit}
          onValueChange={(value) => {
            const parsed = artboardPresetSchema.safeParse(value)
            if (parsed.success)
              actions.resize(
                artboard.id,
                ARTBOARD_PRESETS[parsed.data].width,
                ARTBOARD_PRESETS[parsed.data].height
              )
          }}
        >
          <SelectTrigger aria-label="Size preset" className="h-8 w-full px-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">
              Custom · {size.width} × {size.height}
            </SelectItem>
            {artboardPresetSchema.options.map((option) => (
              <SelectItem key={option} value={option}>
                {ARTBOARD_PRESETS[option].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const width = Math.round(Number(current.width))
            const height = Math.round(Number(current.height))
            if (width >= 16 && height >= 16 && width <= 8192 && height <= 8192)
              actions.resize(artboard.id, width, height)
            else toast.error('Use a size from 16 to 8192 pixels.')
          }}
        >
          <Label className="grid gap-1 text-xs text-muted-foreground">
            W
            <Input
              aria-label="Artboard width"
              value={current.width}
              disabled={!canEdit}
              className="h-8 w-20"
              onChange={(event) => setDraft({ ...current, width: event.target.value })}
            />
          </Label>
          <Label className="grid gap-1 text-xs text-muted-foreground">
            H
            <Input
              aria-label="Artboard height"
              value={current.height}
              disabled={!canEdit}
              className="h-8 w-20"
              onChange={(event) => setDraft({ ...current, height: event.target.value })}
            />
          </Label>
          <Button size="sm" variant="secondary" type="submit" disabled={!canEdit}>
            Resize
          </Button>
        </form>
        <p className="text-[11px] text-muted-foreground">
          Resizing lays the composition out again for the new shape.
        </p>
      </section>
      <section className={section}>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" disabled={!canEdit} onClick={() => actions.edit(artboard.id)}>
            Edit layers
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => actions.duplicate([artboard.id])}
          >
            Duplicate
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDialog('export')}>
            Export
          </Button>
          <FormatsButton actions={actions} ids={[artboard.id]} disabled={!canEdit} />
          {artboard.document.image.src ? (
            <AlternativesButton artboard={artboard} actions={actions} disabled={!canEdit} />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={!canEdit}
            onClick={() => actions.remove([artboard.id])}
          >
            Delete
          </Button>
        </div>
      </section>
      <ProductContextPanel {...props} artboard={artboard} />
    </div>
  )
}

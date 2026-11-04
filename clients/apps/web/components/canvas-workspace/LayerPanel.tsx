'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CanvasComponent } from '@/lib/canvas/components'
import type { Artboard } from '@/lib/canvas/document'
import { groupOf, sameLayer } from '@/lib/canvas/layers'
import { alignModeSchema, type AlignMode } from '@/lib/canvas/layout'
import type { CanvasSession } from '@/lib/canvas/session'
import { useCanvasUi } from '@/lib/canvas/ui-store'
import { instanceOfSelection, type LayerActions } from './use-layer-actions'

const section = 'space-y-2 border-b px-4 py-4'
const heading = 'text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground'
const ALIGN: Record<AlignMode, string> = {
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  top: 'Top',
  middle: 'Middle',
  bottom: 'Bottom',
}

/** Properties of several layers selected together in the open artboard, or of a component instance. */
export function LayerSelectionPanel({
  artboard,
  components,
  actions,
  canEdit,
}: {
  artboard: Artboard
  components: readonly CanvasComponent[]
  actions: LayerActions
  canEdit: boolean
}) {
  const layers = useCanvasUi((ui) => ui.layers)
  const [naming, setNaming] = useState<string | null>(null)
  const group = layers[0] ? groupOf(artboard.groups, layers[0]) : undefined
  const isGroup =
    group &&
    group.layers.length === layers.length &&
    group.layers.every((member) => layers.some((item) => sameLayer(item, member)))
  const instance = instanceOfSelection(artboard, layers)
  const component = instance && components.find((item) => item.id === instance.componentId)
  const overridden = instance ? Object.keys(instance.overrides).length : 0
  return (
    <div data-testid="layer-selection-panel">
      <section className={section}>
        <h2 className="text-ui-lg font-medium">
          {component ? component.name : isGroup ? group!.name : `${layers.length} layers`}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          {component
            ? `Component instance · ${overridden ? `${overridden} overridden layer${overridden === 1 ? '' : 's'}` : 'matches the main component'}`
            : isGroup
              ? 'Group · double-click a layer to edit it alone'
              : 'Shift-click or Shift-drag to change the selection'}
        </p>
        <h3 className={heading}>Align</h3>
        <div className="grid grid-cols-3 gap-1">
          {alignModeSchema.options.map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={!canEdit}
              onClick={() => void actions.align(mode)}
            >
              {ALIGN[mode]}
            </Button>
          ))}
        </div>
        <h3 className={heading}>Distribute</h3>
        <div className="grid grid-cols-2 gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={!canEdit || layers.length < 3}
            onClick={() => void actions.distribute('horizontal')}
          >
            Across
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={!canEdit || layers.length < 3}
            onClick={() => void actions.distribute('vertical')}
          >
            Down
          </Button>
        </div>
      </section>
      <section className={section}>
        <h3 className={heading}>Layers</h3>
        <div className="grid grid-cols-2 gap-1">
          {isGroup ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => void actions.ungroup()}
            >
              Ungroup
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || layers.length < 2}
              onClick={() => void actions.group()}
            >
              Group
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => void actions.duplicate()}
          >
            Duplicate
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            title="Hidden layers stay in the Layers list and out of exports"
            onClick={() => {
              void actions.setVisible(false)
              useCanvasUi.getState().selectLayers([])
            }}
          >
            Hide
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => void actions.remove()}
          >
            Delete
          </Button>
        </div>
      </section>
      <section className={section}>
        <h3 className={heading}>Component</h3>
        {instance ? (
          <div className="grid gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !overridden}
              title="Make this instance's changes the main component; every instance follows"
              onClick={() => void actions.instance('update-component', instance.id)}
            >
              Update main component
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || !overridden}
              onClick={() => void actions.instance('reset-instance', instance.id)}
            >
              Reset overrides
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={() => {
                void actions.instance('detach-instance', instance.id)
                useCanvasUi.getState().selectLayers([])
              }}
            >
              Detach instance
            </Button>
          </div>
        ) : naming !== null ? (
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              const name = naming.trim()
              if (!name) return
              setNaming(null)
              void actions.makeComponent(name)
            }}
          >
            <Input
              autoFocus
              aria-label="Component name"
              value={naming}
              maxLength={80}
              onChange={(event) => setNaming(event.target.value)}
              className="h-8"
            />
            <Button size="sm" type="submit" disabled={!naming.trim()}>
              Create
            </Button>
          </form>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={!canEdit || !layers.length}
            onClick={() => setNaming(isGroup ? group!.name : 'Component')}
          >
            Create component
          </Button>
        )}
      </section>
    </div>
  )
}

/** The canvas's components, placed into the open artboard from the Insert panel. */
export function ComponentList({
  session,
  components,
  actions,
  editing,
  canEdit,
}: {
  session: CanvasSession
  components: readonly CanvasComponent[]
  actions: LayerActions
  editing: boolean
  canEdit: boolean
}) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  if (!components.length)
    return (
      <p className="text-xs text-muted-foreground">
        Select layers in an artboard and choose Create component to reuse them across artboards.
      </p>
    )
  return (
    <ul aria-label="Components" className="grid gap-1">
      {components.map((component) => (
        <li key={component.id} className="flex items-center gap-1 rounded-md border px-2 py-1">
          {renaming?.id === component.id ? (
            <form
              className="flex flex-1 gap-1"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renaming.name.trim()
                if (name)
                  session.command({ type: 'rename-component', componentId: component.id, name })
                setRenaming(null)
              }}
            >
              <Input
                autoFocus
                aria-label="Component name"
                value={renaming.name}
                maxLength={80}
                onChange={(event) => setRenaming({ id: component.id, name: event.target.value })}
                className="h-7"
              />
            </form>
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={`${component.layers.length} layers · version ${component.version}`}
            >
              ◇ {component.name}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={!editing || !canEdit}
            title={editing ? undefined : 'Edit an artboard to place a component in it'}
            onClick={() => void actions.insertComponent(component)}
          >
            Insert
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={!canEdit}
            onClick={() => setRenaming({ id: component.id, name: component.name })}
          >
            Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-destructive"
            disabled={!canEdit}
            title="Instances stay as plain layers"
            onClick={() => session.command({ type: 'remove-component', componentId: component.id })}
          >
            Delete
          </Button>
        </li>
      ))}
    </ul>
  )
}

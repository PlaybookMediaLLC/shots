'use client'

import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { artboardRect, boundsOf, type Artboard } from '@/lib/canvas/document'
import { gridSizeSchema, useCanvasUi, useCanvasViewport } from '@/lib/canvas/ui-store'
import { visibleWorldRect } from '@/lib/canvas/viewport'
import { cn } from '@/lib/utils'
import { CANVAS_SHORTCUTS } from './use-canvas-shortcuts'
import type { CanvasActions } from './use-canvas-actions'

/** Tools, zoom and grid, floating over the board. */
export function ZoomBar({ actions }: { actions: CanvasActions }) {
  const zoom = useCanvasViewport((state) => state.viewport.zoom)
  const tool = useCanvasUi((state) => state.tool)
  const setTool = useCanvasUi((state) => state.setTool)
  const editing = useCanvasUi((state) => Boolean(state.activeId))
  const grid = useCanvasUi((state) => state.grid)
  const setGrid = useCanvasUi((state) => state.setGrid)
  return (
    <div
      data-board-control
      data-board-ignore-wheel
      className="absolute bottom-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] items-center gap-1 overflow-x-auto rounded-lg border bg-background/95 p-1 shadow-sm"
    >
      <Button
        size="sm"
        variant={tool === 'select' ? 'secondary' : 'ghost'}
        aria-pressed={tool === 'select'}
        title="Select (V)"
        onClick={() => setTool('select')}
      >
        Select
      </Button>
      <Button
        size="sm"
        variant={tool === 'hand' ? 'secondary' : 'ghost'}
        aria-pressed={tool === 'hand'}
        title="Hand (H)"
        onClick={() => setTool('hand')}
      >
        Hand
      </Button>
      <Button
        size="sm"
        variant={tool === 'text' ? 'secondary' : 'ghost'}
        aria-pressed={tool === 'text'}
        disabled={!editing}
        title={editing ? 'Text (T): click the artboard to type' : 'Edit an artboard to add text'}
        onClick={() => setTool('text')}
      >
        Text
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => actions.zoomStep(-1)}>
        −
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="min-w-16 tabular-nums"
            aria-label={`Zoom ${Math.round(zoom * 100)}%`}
          >
            {Math.round(zoom * 100)}%
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuItem onSelect={() => actions.zoomStep(1)}>Zoom in · ⌘+</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.zoomStep(-1)}>Zoom out · ⌘−</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.zoomTo(1)}>Zoom to 100% · ⌘0</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.zoomTo(0.5)}>Zoom to 50%</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.zoomTo(2)}>Zoom to 200%</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.fitAll()}>Zoom to fit · ⇧1</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.fitSelection()}>
            Zoom to selection · ⇧2
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.resetView()}>Reset view</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => actions.zoomStep(1)}>
        +
      </Button>
      <span className="mx-1 h-5 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            Grid
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuCheckboxItem
            checked={grid.visible}
            onCheckedChange={(visible) => setGrid({ visible: Boolean(visible) })}
          >
            Show grid
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={grid.snap}
            onCheckedChange={(snap) => setGrid({ snap: Boolean(snap) })}
          >
            Snap to grid and artboards
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Grid size</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={String(grid.size)}
            onValueChange={(value) => {
              const size = gridSizeSchema.safeParse(Number(value))
              if (size.success) setGrid({ size: size.data })
            }}
          >
            {[8, 16, 32, 64].map((size) => (
              <DropdownMenuRadioItem key={size} value={String(size)}>
                {size} px
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Keyboard shortcuts">
            ?
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80">
          <p className="mb-2 text-ui-lg font-medium">Keyboard shortcuts</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {CANVAS_SHORTCUTS.map((shortcut) => (
              <div key={shortcut.keys} className="contents">
                <dt className="font-mono text-muted-foreground">{shortcut.keys}</dt>
                <dd>{shortcut.action}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  )
}

const MAP = { width: 180, height: 120 }

/** The whole board in miniature; click or drag to move the camera there. */
export function Minimap({ artboards }: { artboards: Artboard[] }) {
  const viewport = useCanvasViewport((state) => state.viewport)
  const screen = useCanvasViewport((state) => state.screen)
  const setViewport = useCanvasViewport((state) => state.setViewport)
  const selection = useCanvasUi((state) => state.selection)
  const dragging = useRef(false)
  if (artboards.length < 2) return null
  const rects = artboards.map((artboard) => ({ id: artboard.id, rect: artboardRect(artboard) }))
  const visible = visibleWorldRect(viewport, screen)
  const bounds = boundsOf([...rects.map((item) => item.rect), visible])!
  const scale = Math.min(MAP.width / bounds.width, MAP.height / bounds.height)
  const offset = {
    x: (MAP.width - bounds.width * scale) / 2,
    y: (MAP.height - bounds.height * scale) / 2,
  }
  const map = (x: number, y: number) => ({
    x: (x - bounds.x) * scale + offset.x,
    y: (y - bounds.y) * scale + offset.y,
  })
  const centreOn = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const world = {
      x: (event.clientX - box.left - offset.x) / scale + bounds.x,
      y: (event.clientY - box.top - offset.y) / scale + bounds.y,
    }
    setViewport({
      ...viewport,
      panX: screen.width / 2 - world.x * viewport.zoom,
      panY: screen.height / 2 - world.y * viewport.zoom,
    })
  }
  const view = map(visible.x, visible.y)
  return (
    <div
      data-board-control
      data-board-ignore-wheel
      className="absolute bottom-16 right-3 z-30 hidden rounded-lg border bg-background/95 p-1 shadow-sm md:block"
    >
      <svg
        role="img"
        aria-label="Board overview. Click to move the view."
        width={MAP.width}
        height={MAP.height}
        className="cursor-pointer touch-none"
        onPointerDown={(event) => {
          dragging.current = true
          event.currentTarget.setPointerCapture(event.pointerId)
          centreOn(event)
        }}
        onPointerMove={(event) => {
          if (dragging.current) centreOn(event)
        }}
        onPointerUp={() => {
          dragging.current = false
        }}
      >
        {rects.map(({ id, rect }) => {
          const at = map(rect.x, rect.y)
          return (
            <rect
              key={id}
              x={at.x}
              y={at.y}
              width={Math.max(1, rect.width * scale)}
              height={Math.max(1, rect.height * scale)}
              className={cn(selection.includes(id) ? 'fill-sky-500/70' : 'fill-foreground/25')}
            />
          )
        })}
        <rect
          x={view.x}
          y={view.y}
          width={visible.width * scale}
          height={visible.height * scale}
          className="fill-sky-500/5 stroke-sky-500"
          strokeWidth={1}
        />
      </svg>
    </div>
  )
}

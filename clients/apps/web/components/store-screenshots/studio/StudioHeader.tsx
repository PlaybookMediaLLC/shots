'use client'

import { publicImageUrl } from '@/lib/assets/public-image'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowUUpRightIcon as RedoIcon } from '@phosphor-icons/react/dist/ssr/ArrowUUpRight'
import { ArrowUUpLeftIcon as UndoIcon } from '@phosphor-icons/react/dist/ssr/ArrowUUpLeft'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { localeName } from '@/lib/store-screenshots/locales'
import { STORE_TARGETS } from '@/lib/store-screenshots/targets'
import { cn } from '@/lib/utils'
import { useStudioActions } from './actions'
import { IconButton } from './controls'
import { useEditor, useEditorApi, type SaveStatus, type ViewOptions } from './editor-store'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

const SAVE_LABELS: Record<SaveStatus, string> = {
  saved: 'Saved on this browser',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Changed in another tab',
}

const VIEW_LABELS: Record<keyof ViewOptions, string> = {
  guides: 'Smart guides',
  snapping: 'Snapping',
  safeArea: 'Safe area',
  rulers: 'Rulers',
  grid: 'Grid',
}

/** The studio header: project, history, view, and the export/publish workflow. */
export function StudioHeader({
  issueCount,
  onKeepMine,
  onLoadTheirs,
  onSaveVersion,
  onStartOver,
  workspaceStatus,
}: {
  issueCount: { requirements: number; recommendations: number }
  onKeepMine: () => void
  onLoadTheirs: () => void
  onSaveVersion: () => void
  onStartOver: () => void
  /** Where the project stands in the workspace, after this browser's save status. */
  workspaceStatus?: React.ReactNode
}): React.JSX.Element {
  const api = useEditorApi()
  const actions = useStudioActions()
  const name = useEditor((state) => state.document.name)
  const canUndo = useEditor((state) => state.history.past.length > 0)
  const canRedo = useEditor((state) => state.history.future.length > 0)
  const saveStatus = useEditor((state) => state.saveStatus)
  const targetId = useEditor((state) => state.targetId)
  const locale = useEditor((state) => state.locale)
  const localization = useEditor((state) => state.document.localization)
  const view = useEditor((state) => state.view)
  const [renaming, setRenaming] = React.useState(false)

  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-foreground/10 bg-background px-3 py-2 lg:h-14 lg:flex-nowrap lg:py-0">
      <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Shots home">
        <Image src={publicImageUrl("/logo-mark.png")} alt="" width={28} height={28} className="size-7" priority />
      </Link>
      <div className="flex min-w-0 items-center gap-2">
        {renaming ? (
          <Input
            autoFocus
            defaultValue={name}
            aria-label="Project name"
            maxLength={120}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next && next !== name) api.getState().dispatch({ type: 'project.patch', patch: { name: next } })
              setRenaming(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') setRenaming(false)
            }}
            className="h-8 w-48 rounded-md border border-foreground/20 bg-background px-2 text-sm outline-none"
          />
        ) : (
          <Button variant="custom" size={null} type="button" onClick={() => setRenaming(true)} title="Rename project" className="max-w-56 truncate rounded-md px-1.5 py-1 text-ui-lg font-medium hover:bg-foreground/[0.05]">
            {name}
          </Button>
        )}
        <span
          role="status"
          aria-live="polite"
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px]',
            saveStatus === 'error' || saveStatus === 'conflict' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
          )}
        >
          {SAVE_LABELS[saveStatus]}
        </span>
        {saveStatus === 'conflict' ? (
          <span className="flex items-center gap-1">
            <Button variant="custom" size={null} type="button" onClick={onLoadTheirs} className="h-7 rounded-md border border-foreground/15 px-2 text-[11px]">
              Load their version
            </Button>
            <Button variant="custom" size={null} type="button" onClick={onKeepMine} className="h-7 rounded-md bg-foreground px-2 text-[11px] text-background">
              Keep mine
            </Button>
          </span>
        ) : null}
        {workspaceStatus}
      </div>

      <div className="mx-auto flex max-w-full flex-wrap items-center gap-1">
        <IconButton label="Undo" shortcut="⌘Z" disabled={!canUndo} onClick={() => api.getState().undo()}>
          <UndoIcon size={15} />
        </IconButton>
        <IconButton label="Redo" shortcut="⇧⌘Z" disabled={!canRedo} onClick={() => api.getState().redo()}>
          <RedoIcon size={15} />
        </IconButton>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-foreground/10" />
        <Label className="sr-only" htmlFor="canvas-target">
          Canvas size
        </Label>
        <Select
          value={targetId}
          onValueChange={(nextValue) => api.getState().setTarget(nextValue)}
        >
          <SelectTrigger
            id="canvas-target"
            title="Preview and adjust the design at a store size"
            className="h-8 max-w-40 rounded-md border border-foreground/10 bg-background px-2 text-xs"
            aria-label={'Preview and adjust the design at a store size'}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STORE_TARGETS.map((target) => (
              <SelectItem key={target.id} value={target.id}>
                {target.shortName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {localization.locales.length ? (
          <>
            <Label className="sr-only" htmlFor="canvas-locale">
              Editing language
            </Label>
            <Select
              value={locale}
              onValueChange={(nextValue) => api.getState().setLocale(nextValue)}
            >
              <SelectTrigger
                id="canvas-locale"
                className="h-8 max-w-36 rounded-md border border-foreground/10 bg-background px-2 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[localization.sourceLocale, ...localization.locales].map((code) => (
                  <SelectItem key={code} value={code}>
                    {localeName(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 text-xs">
              View
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-48">
            <DropdownMenuLabel className="text-xs">Canvas aids</DropdownMenuLabel>
            {(Object.keys(VIEW_LABELS) as Array<keyof ViewOptions>).map((key) => (
              <DropdownMenuCheckboxItem key={key} checked={view[key]} onCheckedChange={() => api.getState().toggleView(key)} onSelect={(event) => event.preventDefault()} className="text-xs">
                {VIEW_LABELS[key]}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onSelect={() => api.getState().setZoom(null)}>
              Fit to screen
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('shortcuts')}>
              Keyboard shortcuts
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => actions.openDialog('checks')} title="Store requirements and design checks for the planned export">
          Checks
          {issueCount.requirements + issueCount.recommendations > 0 ? (
            <span className={cn('rounded-full px-1.5 text-[10px] tabular-nums', issueCount.requirements ? 'bg-destructive/15 text-destructive' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
              {issueCount.requirements + issueCount.recommendations}
            </span>
          ) : null}
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => actions.openDialog('preview')}>
          Store preview
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 text-xs">
              Project
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('projects')}>
              Projects in this browser…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={onSaveVersion}>
              Save a named version…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('versions')}>
              Version history…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('templates')}>
              Templates…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('saveTemplate')}>
              Save as template…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('brandKits')}>
              Brand kits…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('animation')}>
              Animated preview, GIF, MP4…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('review')}>
              Share for review…
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onSelect={() => actions.openDialog('publish')}>
              Upload to App Store Connect or Google Play…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs text-destructive" onSelect={onStartOver}>
              Delete this project…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" className="h-8 text-xs" onClick={() => actions.openDialog('export')} aria-keyshortcuts="Meta+E">
          Export
        </Button>
      </div>
    </header>
  )
}

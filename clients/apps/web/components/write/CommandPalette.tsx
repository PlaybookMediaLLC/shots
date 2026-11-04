'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import { useTranslations } from 'next-intl'
import { PLATFORM_DESTINATIONS } from '@/lib/platform/navigation'
import { createWritingDraft } from './pending-draft'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@shots/platejs-editor/ui'
import { useKeys } from './shortcuts'
import { draftHref, type EditorCommandEntry, rememberSet, useWrite } from './write-context'

/**
 * Search and commands (⌘K): the set's drafts by text, its tags, switching
 * sets, and navigation. Choosing an item closes the palette and returns
 * focus to what opened it.
 */
export default function CommandPalette({
  campaignsEnabled,
  onClose,
  onShortcuts,
}: {
  campaignsEnabled: boolean
  onClose: () => void
  onShortcuts: () => void
}) {
  const t = useTranslations('platformNavigation')
  const keys = useKeys()
  const router = useWriteRouter()
  const { beforeLeaveRef, openPreviewRef, editorCommandsRef, activeId, canEdit, data, setQuery } =
    useWrite()
  // Read once as the palette opens: the editor's commands for the version being edited.
  const [editorCommands, setEditorCommands] = React.useState<EditorCommandEntry[]>([])
  React.useEffect(() => setEditorCommands(editorCommandsRef.current?.() ?? []), [editorCommandsRef])
  const [results, setResults] = React.useState<{ id: string; title: string; plainText: string }[]>(
    []
  )
  const [search, setSearch] = React.useState('')
  const [searchError, setSearchError] = React.useState(false)
  React.useEffect(() => {
    setSearchError(false)
    if (!search.trim()) return setResults([])
    const controller = new AbortController()
    const query = new URLSearchParams({ limit: '20', search: search.trim() })
    if (data.activeSet) query.set('socialSetId', data.activeSet.id)
    const timer = setTimeout(() => {
      void fetch(`/api/v1/content-drafts?${query}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error('Search failed')
          return response.json()
        })
        .then(
          (body: { items: typeof results; pinned: typeof results }) =>
            !controller.signal.aborted && setResults([...body.pinned, ...body.items])
        )
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([])
            setSearchError(true)
          }
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [data.activeSet, search])
  const go = (run: () => void) => {
    onClose()
    run()
  }
  return (
    <CommandDialog onOpenChange={(open) => !open && onClose()} open>
      <CommandInput
        onValueChange={setSearch}
        placeholder="Search drafts, tags, sets and commands"
        value={search}
      />
      <CommandList>
        {searchError ? (
          <p role="status" className="p-3 text-sm text-destructive">
            Some draft results could not load. Try searching again.
          </p>
        ) : (
          <CommandEmpty>Nothing matches.</CommandEmpty>
        )}
        <CommandGroup heading="This workspace · Destinations">
          {PLATFORM_DESTINATIONS.filter((item) => campaignsEnabled || item.key !== 'campaigns').map(
            (item) => (
              <CommandItem
                key={item.key}
                value={`destination ${t(item.key)}`}
                onSelect={() =>
                  go(() =>
                    router.push(
                      item.key === 'publish' && data.activeSet
                        ? `/write?set=${data.activeSet.id}`
                        : item.href
                    )
                  )
                }
              >
                {t(item.key)}
              </CommandItem>
            )
          )}
        </CommandGroup>
        {results.length > 0 ? (
          <CommandGroup heading="Drafts">
            {results.map((draft) => (
              <CommandItem
                key={draft.id}
                onSelect={() => go(() => router.push(draftHref(draft.id, data.activeSet?.id)))}
                value={`draft ${draft.id} ${draft.title} ${draft.plainText}`}
              >
                <span className="truncate">{draft.title}</span>
                <span className="ml-2 truncate text-xs text-muted-foreground">
                  {draft.plainText.slice(0, 60)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {editorCommands.length ? (
          <CommandGroup heading="In the editor">
            {editorCommands.map((command) => (
              <CommandItem
                key={command.id}
                value={`Editor ${command.label}`}
                // After the palette closes and focus is back in the editor.
                onSelect={() => go(() => requestAnimationFrame(command.run))}
              >
                {command.label}
                {command.shortcut ? (
                  <CommandShortcut>{keys.label(command.shortcut)}</CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Commands">
          {activeId ? (
            <CommandItem
              value="Preview current draft"
              onSelect={() => go(() => openPreviewRef.current?.())}
            >
              Preview current draft
              <CommandShortcut>{keys.label({ key: 'v', mod: true, shift: true })}</CommandShortcut>
            </CommandItem>
          ) : null}
          {canEdit ? (
            <CommandItem
              onSelect={() =>
                go(
                  () =>
                    void createWritingDraft(
                      { socialSetId: data.activeSet?.id },
                      (id) => router.push(draftHref(id, data.activeSet?.id)),
                      beforeLeaveRef.current ?? undefined
                    )
                )
              }
            >
              New draft
              <CommandShortcut>{keys.label({ key: '.', mod: true })}</CommandShortcut>
            </CommandItem>
          ) : null}
          <CommandItem
            onSelect={() =>
              go(() => router.push(`/write${data.activeSet ? `?set=${data.activeSet.id}` : ''}`))
            }
          >
            Go to Write
            <CommandShortcut>{keys.label({ key: '1', mod: true, shift: true })}</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              go(() =>
                router.push(`/write/plan${data.activeSet ? `?set=${data.activeSet.id}` : ''}`)
              )
            }
          >
            Go to Calendar
            <CommandShortcut>{keys.label({ key: '2', mod: true, shift: true })}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go(() => setQuery({ tab: 'queue' }))}>
            Show the queue
          </CommandItem>
          <CommandItem onSelect={() => go(onShortcuts)}>
            Keyboard shortcuts
            <CommandShortcut>{keys.label({ key: '/', mod: true, shift: true })}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        {data.experiments.tags && data.tags.length > 0 ? (
          <CommandGroup heading="Filter by tag">
            {data.tags.map((tag) => (
              <CommandItem
                key={tag.id}
                onSelect={() => go(() => setQuery({ tag: tag.id }))}
                value={`tag ${tag.name}`}
              >
                #{tag.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        <CommandGroup heading="Publishing brands">
          {data.sets.map((set) => (
            <CommandItem
              key={set.id}
              onSelect={() =>
                go(() => {
                  rememberSet(set.id)
                  setQuery({ set: set.id, tag: undefined })
                })
              }
              value={`set ${set.id} ${set.name}`}
            >
              {set.name}
              <span className="ml-2 text-xs text-muted-foreground">
                {set.accounts
                  .map((connection) => connection.handle ?? connection.platform)
                  .join(' · ')}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

'use client'

import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from 'fumadocs-ui/components/dialog/search'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { useDocsPages } from '@/app/[locale]/docs/provider'
import { filterIndexedDocsPages, indexDocsSearchEntries } from '@/lib/docs/search-filter'

const MAX_VISIBLE_RESULTS = 20

const SEARCH_EMPTY_LABELS = {
  failed: 'Search is not available. Close this dialog and try again.',
  loading: 'Loading search...',
  ready: 'No documentation pages found.',
} as const

export default function DocsSearchDialog({ onOpenChange, open }: SharedProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { pages, status } = useDocsPages(open)
  const initialQuery = searchParams.get('q')?.trim() || searchParams.get('search')?.trim() || ''
  const [search, setSearch] = useState(initialQuery)

  useEffect(() => {
    setSearch(open ? initialQuery : '')
  }, [initialQuery, open])

  const indexedPages = useMemo(() => indexDocsSearchEntries(pages), [pages])
  const filtered = filterIndexedDocsPages(indexedPages, search).slice(0, MAX_VISIBLE_RESULTS)

  const items = filtered.map(({ badge, entry }) => ({
    id: entry.id,
    node: (
      <div className="flex min-w-0 flex-col text-left">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium text-fd-popover-foreground">{entry.title}</span>
          <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
            {badge}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {entry.description ?? entry.excerpt ?? entry.url}
        </span>
      </div>
    ),
    onSelect: () => {
      onOpenChange(false)
      router.push(entry.url)
    },
    type: 'action' as const,
  }))

  return (
    <SearchDialog
      onOpenChange={onOpenChange}
      onSearchChange={setSearch}
      open={open}
      search={search}
    >
      <SearchDialogOverlay className="z-[110]" />
      <SearchDialogContent className="docs-shell z-[111] rounded-xl border-border bg-popover shadow-[var(--shadow-popover)]">
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput placeholder="Search Shots documentation..." />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList
          Empty={() => (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {SEARCH_EMPTY_LABELS[status]}
            </div>
          )}
          items={items}
        />
        <SearchDialogFooter>
          <p className="text-caption text-muted-foreground">
            Search Shots product docs, guides, and API reference. Press <kbd>Enter</kbd> to open.
          </p>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  )
}

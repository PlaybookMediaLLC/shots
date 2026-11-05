'use client'

import * as React from 'react'
import { registerNavigationGuard } from '@/lib/platform/navigation-guard'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { WriteData } from '@/app/[locale]/publish/write-data'
import { libraryDraft, libraryQuery, libraryRange } from '@/lib/write/library'
import type { DraftWire } from '@/lib/content-drafts/client'
import { toast } from 'sonner'
import { platformHref } from '@/lib/platform/navigation'
import { SOCIAL_SET_COOKIE } from '@/lib/settings/appearance'
import type { Shortcut } from './shortcuts'

/** An editor command as the palette lists it. */
export type EditorCommandEntry = {
  id: string
  label: string
  shortcut?: Pick<Shortcut, 'alt' | 'key' | 'mod' | 'shift'>
  run: () => void
}

/**
 * Write's shared client state (RFC 025): the library the page loaded, and
 * helpers to change the URL state it is filtered by. Panels and dialogs are
 * UI state only; nothing here is saved with a draft.
 */

/** The library a Write page loaded. */
export type WriteLibrary = WriteData

/** A profile as the browser holds it. */
export type WriteSet = WriteData['sets'][number]

/** One action of the open draft, as the command palette lists it. */
export type DraftCommand = {
  label: string
  run: () => void
  /** The shortcut that runs it, as the composer shows it. */
  shortcut?: string
}

/** A draft row in the library. */
export type LibraryDraft = WriteData['library'][number]

/** A set's tag in the library. */
export type LibraryTag = WriteData['tags'][number]

type WriteContextValue = {
  data: WriteLibrary
  /** The draft open in the main area, if any. */
  activeId?: string
  canEdit: boolean
  canManageSets: boolean
  canPublish: boolean
  canReview: boolean
  /** Update the library's URL state; undefined removes a key. */
  setQuery: (next: Record<string, string | undefined>) => void
  /** The draft list as last saved or edited here: the open draft's line stays current. */
  showSaved: (draft: { id: string } & DraftLine) => void
  hideDraft: (id: string) => void
  beforeLeaveRef: React.MutableRefObject<(() => Promise<void>) | null>
  /** Opens the mounted composer's preview without navigation or an editor remount. */
  openPreviewRef: React.MutableRefObject<(() => void) | null>
  /** The open draft's actions, as its composer offers them, for the command palette. */
  draftCommandsRef: React.MutableRefObject<DraftCommand[]>
  /** Archives or restores the open draft through its composer, which keeps its version. */
  archiveRef: React.MutableRefObject<((status: 'draft' | 'archived') => Promise<void>) | null>
  /** The open editor's commands (composer/commands.tsx), for the command palette. */
  editorCommandsRef: React.MutableRefObject<(() => EditorCommandEntry[]) | null>
  saved: Record<string, DraftLine>
  /** The list for the chosen tab or search is still loading. */
  libraryPending: boolean
}

/** What this browser knows about a draft's row before the server's list does. */
type DraftLine = { excerpt?: string; pinned?: boolean; title?: string; updatedAt?: string }

const WriteContext = React.createContext<WriteContextValue | null>(null)

const TABS = ['all', 'drafts', 'failed', 'queue', 'posted', 'archived'] as const

/** The Write context; every Write component sits inside a provider. */
export function useWrite(): WriteContextValue {
  const value = React.useContext(WriteContext)
  if (!value) throw new Error('useWrite outside WriteProvider')
  return value
}

/** Provides the library and its URL state to the Write components. */
export function WriteProvider({
  activeId,
  canEdit,
  canManageSets,
  canPublish,
  canReview,
  children,
  data,
}: {
  activeId?: string
  canEdit: boolean
  canManageSets: boolean
  canPublish: boolean
  canReview: boolean
  children: React.ReactNode
  data: WriteLibrary
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const beforeLeaveRef = React.useRef<(() => Promise<void>) | null>(null)
  const openPreviewRef = React.useRef<(() => void) | null>(null)
  const draftCommandsRef = React.useRef<DraftCommand[]>([])
  const archiveRef = React.useRef<((status: 'draft' | 'archived') => Promise<void>) | null>(null)
  const editorCommandsRef = React.useRef<(() => EditorCommandEntry[]) | null>(null)
  React.useEffect(() => registerNavigationGuard(() => beforeLeaveRef.current?.()), [])
  React.useEffect(() => {
    const guard = (event: MouseEvent) => {
      const target = event.target as Element | null
      const link = target?.closest<HTMLAnchorElement>('a[href]')
      if (
        !link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        link.target ||
        link.download
      )
        return
      if (link.closest('[data-selecting="true"]')) return
      const url = new URL(link.href)
      if (
        url.origin !== window.location.origin ||
        url.pathname === window.location.pathname ||
        !beforeLeaveRef.current
      )
        return
      event.preventDefault()
      event.stopPropagation()
      void beforeLeaveRef
        .current()
        .then(() => router.push(url.pathname + url.search + url.hash))
        .catch(() => {})
    }
    document.addEventListener('click', guard, true)
    return () => document.removeEventListener('click', guard, true)
  }, [router])
  const [removed, setRemoved] = React.useState<string[]>([])
  const hideDraft = React.useCallback(
    (id: string) => {
      // A confirmed deletion must not try to flush the now-missing draft on its way out.
      if (id === activeId) beforeLeaveRef.current = null
      setRemoved((current) => [...current, id])
    },
    [activeId]
  )
  const [saved, setSaved] = React.useState<WriteContextValue['saved']>({})
  const [query] = React.useState(() => libraryQuery(() => window.location.search))
  // Any committed URL, ours or back/forward, is the query from here on.
  React.useEffect(() => query.settle(), [params, pathname, query])
  const setQuery = React.useCallback(
    (next: Record<string, string | undefined>) => {
      const { navigate, search } = query.change(next)
      const href = `${pathname}${search ? `?${search}` : ''}`
      if (navigate) router.replace(href, { scroll: false })
      else window.history.replaceState(null, '', href)
    },
    [pathname, query, router]
  )
  const showSaved = React.useCallback<WriteContextValue['showSaved']>(
    ({ id, ...draft }) =>
      setSaved((current) => ({ ...current, [id]: { ...current[id], ...draft } })),
    []
  )
  // A pin shows at once, until the server's list arrives; from then on, it is the server's.
  React.useEffect(
    () =>
      setSaved((current) =>
        Object.values(current).some((line) => line.pinned !== undefined)
          ? Object.fromEntries(
              Object.entries(current).map(([id, line]) => {
                const next = { ...line }
                delete next.pinned
                return [id, next]
              })
            )
          : current
      ),
    [data]
  )
  const search = params.get('q') ?? ''
  // Tabs switch in the browser: Drafts and Queue share the loaded list, others load as JSON.
  const tab = TABS.find((item) => item === params.get('tab')) ?? 'drafts'
  const view = tab === 'queue' ? 'drafts' : tab
  const loaded = view === (data.query.tab === 'queue' ? 'drafts' : data.query.tab)
  const [results, setResults] = React.useState<{
    key: string
    items: LibraryDraft[]
    hasMore: boolean
  } | null>(null)
  const searchQuery = new URLSearchParams({ limit: '100', search })
  // All leaves the view out, which leaves out only archived drafts.
  if (view !== 'all') searchQuery.set('view', view)
  if (data.query.account) searchQuery.set('connectionId', data.query.account)
  for (const [key, at] of Object.entries(
    libraryRange(data.query, data.activeSet?.timeZone ?? 'UTC')
  ))
    searchQuery.set(key, at)
  if (data.activeSet) searchQuery.set('socialSetId', data.activeSet.id)
  if (data.query.kind) searchQuery.set('kind', data.query.kind)
  if (data.query.sort) searchQuery.set('sort', data.query.sort)
  if (data.experiments.tags && data.query.tag) searchQuery.set('tagId', data.query.tag)
  const searchKey = searchQuery.toString()
  // Another tab, or a search past the loaded page, comes from the drafts API.
  const fetched = !loaded || Boolean(search && data.hasMore)
  React.useEffect(() => {
    if (!fetched) return
    // Search beyond the loaded page, or load another tab, through JSON without remounting the route.
    const controller = new AbortController()
    void fetch(`/api/v1/content-drafts?${searchKey}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Search failed. Try again.')
        const page = (await response.json()) as {
          pinned: DraftWire[]
          items: DraftWire[]
          nextCursor: string | null
        }
        if (!controller.signal.aborted)
          setResults({
            key: searchKey,
            items: [...page.pinned, ...page.items].map(libraryDraft),
            hasMore: page.nextCursor !== null,
          })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        toast.error(
          loaded
            ? 'Search failed. Showing matches from loaded drafts.'
            : 'This list could not load. Try again.'
        )
        // A tab with nothing loaded stops showing its loading rows.
        if (!loaded) setResults({ key: searchKey, items: [], hasMore: false })
      })
    return () => controller.abort()
    // A refreshed page (after an archive, restore or pin) reloads the fetched list too.
  }, [data, fetched, loaded, searchKey])
  const remote = fetched && results?.key === searchKey ? results.items : null
  const remoteHasMore = fetched && results?.key === searchKey ? results.hasMore : null
  const libraryPending = !loaded && !remote
  const visibleData = React.useMemo(
    () => ({
      ...data,
      hasMore: remoteHasMore ?? data.hasMore,
      query: { ...data.query, q: search || undefined, tab },
      queue: data.queue.filter((item) =>
        item.caption.toLocaleLowerCase().includes(search.toLocaleLowerCase())
      ),
      library: (remote ?? (loaded ? data.library : []))
        .filter((draft) => {
          if (removed.includes(draft.id)) return false
          const latest = saved[draft.id]
          return `${latest?.title ?? draft.title} ${draft.searchText} ${latest?.excerpt ?? ''}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase())
        })
        // A post that failed or needs a check leads whichever list it is in; the sort stays stable.
        .sort((a, b) => Number(b.attentionPosts > 0) - Number(a.attentionPosts > 0)),
    }),
    [data, loaded, remoteHasMore, removed, remote, saved, search, tab]
  )
  const value = React.useMemo(
    () => ({
      beforeLeaveRef,
      draftCommandsRef,
      openPreviewRef,
      archiveRef,
      editorCommandsRef,
      hideDraft,
      activeId,
      canEdit,
      canManageSets,
      canPublish,
      canReview,
      data: visibleData,
      libraryPending,
      saved,
      setQuery,
      showSaved,
    }),
    [
      activeId,
      canEdit,
      canManageSets,
      canPublish,
      canReview,
      hideDraft,
      visibleData,
      libraryPending,
      saved,
      setQuery,
      showSaved,
    ]
  )
  return <WriteContext.Provider value={value}>{children}</WriteContext.Provider>
}

/** The URL of a draft, keeping the library's set so links stay in the workspace's context. */
export function draftHref(
  id: string,
  setId?: string | null,
  panel?: string,
  tab?: string
): string {
  const query = new URLSearchParams()
  if (setId) query.set('set', setId)
  if (panel) query.set('panel', panel)
  // The list stays on the tab it was opened from; Drafts is the default.
  if (tab && tab !== 'drafts') query.set('tab', tab)
  return `/publish/${encodeURIComponent(id)}${query.size > 0 ? `?${query}` : ''}`
}

/** "now", "5m", "3h", "2d", then a date: how long ago something happened. */
export function since(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 60 / 24)}d`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Remember the set chosen last, for the next visit. */
export function rememberSet(id: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: a plain preference cookie, read by the server
  document.cookie = `${SOCIAL_SET_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`
}

/** Save the open document before a programmatic navigation. */
export function useWriteRouter() {
  const router = useRouter()
  const pathname = usePathname()
  const { beforeLeaveRef } = useWrite()
  return React.useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) => {
        args[0] = platformHref(pathname, args[0])
        if (!beforeLeaveRef.current) return router.push(...args)
        void beforeLeaveRef
          .current()
          .then(() => router.push(...args))
          .catch(() => {})
      },
      replace: (...args: Parameters<typeof router.replace>) => {
        args[0] = platformHref(pathname, args[0])
        if (!beforeLeaveRef.current) return router.replace(...args)
        void beforeLeaveRef
          .current()
          .then(() => router.replace(...args))
          .catch(() => {})
      },
    }),
    [beforeLeaveRef, pathname, router]
  )
}

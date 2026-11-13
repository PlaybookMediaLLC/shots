'use client'

import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { BulkScheduleDialog } from './bulk-schedule'

import { useWriteRouter } from '@/components/write/write-context'
import { useSearchParams } from 'next/navigation'

import * as React from 'react'
// Hover-intent prefetch: the rail lists up to 100 drafts.
import { SidebarLink as Link } from '@/components/platform-shell/SidebarLink'
import { ProductTourButton } from '@/components/platform-shell/ProductTour'
import { toast } from 'sonner'
import { PlusIcon as Add01Icon } from '@phosphor-icons/react/dist/ssr/Plus'
import { PushPinIcon as PinIcon } from '@phosphor-icons/react/dist/ssr/PushPin'
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { datePreset, draftName } from '@/lib/write/library'
import { useHydratedSession } from '@/lib/auth/client'
import { trackPostManagementUse } from '@/lib/plan/feature-use'
import { zonedDayKey } from '@/lib/settings/zoned-time'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { openBrandSettings } from '@/components/drafts/DraftSettingsDrawer'
import { LocalTime, useHydrated } from '@/components/drafts/local-time'
import { draftsApi } from '@/lib/content-drafts/client'
import { listedAttention, postState, stateLabel } from '@/lib/content-drafts/post-status'
import {
  channelForPlatform,
  platformCaptionLength,
  platformLabel,
} from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { type QueueRow, queueGroups, queueRuns, queueWarnings } from '@/lib/write/queue-actions'
import { DraftPostLinks, QueueBulkBar, QueueWarnings, RetryAllFailed } from './queue-tools'
import { writeApi } from '@/lib/write/client'
import { carriedChannels } from '@/lib/write/composing-session'
import { queueDays } from '@/lib/write/calendar'
import { wallTime } from '@/lib/write/zoned-time'
import { socialSetHref } from '@/components/workspace/settings-sections'
import type { DraftKind } from '@/lib/write/document'
import type { ContentDraftSort } from '@/lib/write/wire'
import { cn } from '@/lib/utils'
import { SetDot, SocialSetSwitcher } from './sets'
import { TagChip, TagManager } from './tags'
import {
  draftHref,
  type LibraryDraft,
  since,
  useNewDraft,
  useWrite,
  type WriteLibrary,
} from './write-context'
import { useKeys } from './shortcuts'
import { createWritingDraft } from './pending-draft'

/** The drag type a queued post carries, so only a queue row accepts it. */
const QUEUE_DRAG = 'application/x-shots-queue-post'

/** The library tabs, in order. */
const TABS = [
  { label: 'All', tab: 'all' },
  { label: 'Drafts', tab: 'drafts' },
  { label: 'Failed', tab: 'failed' },
  { label: 'Queue', tab: 'queue' },
  { label: 'Posted', tab: 'posted' },
  { label: 'Archived', tab: 'archived' },
] as const

/** What the search box looks through on each tab. */
const SEARCH_LABELS: Record<(typeof TABS)[number]['tab'], string> = {
  all: 'Search all posts',
  archived: 'Search archived drafts',
  drafts: 'Search drafts',
  failed: 'Search failed posts',
  posted: 'Search posted',
  queue: 'Search the queue',
}

/** A menu's group heading: quieter than its items, so it does not read as one. */
const MENU_GROUP = 'pt-2 pb-1 text-[11px] font-normal uppercase tracking-wide text-muted-foreground'

/** The date presets, by the label the picker shows. */
const DATE_PRESETS = { Today: 'today', 'This week': 'week', 'This month': 'month' } as const

/** Everything a filter can set, for the buttons that clear them all. */
const NO_FILTERS = {
  account: undefined,
  from: undefined,
  kind: undefined,
  q: undefined,
  tag: undefined,
  to: undefined,
}

/** The orders the library sorts by. */
const SORTS: { label: string; sort: ContentDraftSort }[] = [
  { label: 'Recently updated', sort: 'updated_desc' },
  { label: 'Least recently updated', sort: 'updated_asc' },
  { label: 'Newest created', sort: 'created_desc' },
  { label: 'Oldest created', sort: 'created_asc' },
]

/** A kind's label in the library. */
const KIND_LABELS: Record<DraftKind, string> = {
  article: 'Article',
  quote: 'Quote',
  reply: 'Reply',
  repurpose: 'Repurposed',
  standard: 'Post',
}

/**
 * The left rail: the brand, the lifecycle tabs, search and filters,
 * new drafts, and the draft list with its actions. Every action that
 * changes access (a public link) asks first.
 */
export function WriteRail() {
  const { activeId, canEdit, canPublish, data, libraryPending, setQuery } = useWrite()
  const [now, setNow] = React.useState<number | undefined>()
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const [selected, setSelected] = React.useState<string[]>([])
  const [lastClicked, setLastClicked] = React.useState<string | null>(null)
  const [managingTags, setManagingTags] = React.useState(false)
  const tab = data.query.tab
  // A run of drafts just split out of one paste arrives here named in the URL:
  // select them and open the series scheduler, so one confirmation times them
  // all. The parameter is cleared once read, so a reload is not a second step.
  const params = useSearchParams()
  const series = params.get('series')
  const [scheduling, setScheduling] = React.useState(false)
  React.useEffect(() => {
    if (!series) return
    const ids = series.split(',').filter(Boolean)
    if (ids.length) {
      setSelected(ids)
      setScheduling(true)
    }
    setQuery({ series: undefined })
  }, [series, setQuery])
  const filtered = Boolean(
    data.query.q ||
    data.query.tag ||
    data.query.kind ||
    data.query.account ||
    data.query.from ||
    data.query.to
  )
  // Drafts with a queued post are still drafts, but they are not unfinished
  // work; the Drafts tab can set them aside without changing what a draft is.
  const [hideQueued, setHideQueued] = React.useState(false)
  const queuedInList =
    tab === 'drafts' ? data.library.filter((draft) => draft.queuedPosts > 0).length : 0
  const shownLibrary =
    tab === 'drafts' && hideQueued
      ? data.library.filter((draft) => draft.queuedPosts === 0)
      : data.library
  const select = (id: string, range: boolean) => {
    setSelected((current) => {
      if (range && lastClicked) {
        const ids = shownLibrary.map((draft) => draft.id)
        const [from, to] = [ids.indexOf(lastClicked), ids.indexOf(id)].sort((a, b) => a - b)
        return [...new Set([...current, ...ids.slice(from, to + 1)])]
      }
      return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    })
    setLastClicked(id)
  }
  return (
    <aside
      aria-label="Publish library"
      className="flex h-full min-h-0 w-full flex-col"
      data-testid="write-rail"
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-4">
        <h2 className="text-heading">Publish</h2>
        <div className="flex items-center gap-1">
          <ProductTourButton label="Take the Publish tour" tourId="publish" />
          {canEdit && (
            <Button asChild variant="outline" size="sm">
              {/* A durable batch of separate posts, reopened after a reload (RFC 042). */}
              <Link
                data-tour-id="write-bulk"
                href={`/publish/batches${data.activeSet ? `?set=${encodeURIComponent(data.activeSet.id)}` : ''}`}
              >
                Bulk tools
              </Link>
            </Button>
          )}
        </div>
      </div>
      <p className="platform-eyebrow px-3 pt-3">Profile</p>
      <div className="flex items-center gap-1 px-3 pt-1 pb-2" data-tour-id="write-brand">
        <div className="min-w-0 flex-1">
          <SocialSetSwitcher />
        </div>
        {data.activeSet ? (
          <Button
            className="rounded-md px-2 py-1 text-ui text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => openBrandSettings('scheduling')}
            size={null}
            type="button"
            variant="custom"
          >
            Settings
          </Button>
        ) : null}
      </div>
      {/* Underlined tabs: the current one is medium weight over a 2px line. */}
      <div
        className="border-b border-border px-1"
        data-tour-id="write-tabs"
        role="tablist"
        aria-label="Library"
      >
        {/* They wrap rather than scroll, so no tab is cut off or moves under the pointer. */}
        <div className="flex flex-wrap">
          {/* Failed appears while something failed, or while it is the open tab. */}
          {TABS.filter(
            (item) => item.tab !== 'failed' || data.failedCount > 0 || tab === 'failed'
          ).map((item) => (
            <Button
              aria-selected={tab === item.tab}
              className={cn(
                'flex h-10 shrink-0 items-center px-2.5 py-2.5 text-ui transition-colors',
                tab === item.tab
                  ? 'font-medium text-foreground shadow-[inset_0_-2px_0_var(--foreground)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              data-testid={`library-tab-${item.tab}`}
              key={item.tab}
              onClick={() => {
                setSelected([])
                setQuery({ tab: item.tab === 'drafts' ? undefined : item.tab })
              }}
              role="tab"
              size={null}
              type="button"
              variant="custom"
            >
              {item.label}
              {item.tab === 'queue' && data.queue.length > 0 ? (
                <span className="ml-1 text-[11px] leading-[11px] font-semibold text-muted-foreground">
                  {data.queue.length}
                </span>
              ) : null}
              {item.tab === 'failed' && data.failedCount > 0 ? (
                <span
                  className="ml-1 text-[11px] leading-[11px] font-semibold text-red-700 dark:text-red-300"
                  data-testid="failed-count"
                >
                  {data.failedCount}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
      </div>
      <LibraryFilters onManageTags={() => setManagingTags(true)} />
      {/* The search box shows its own text: a chip for it pushed the list down on every keystroke. */}
      {/* The queue applies only the account and dates, so only those show on it. */}
      {(tab !== 'queue' && (data.query.kind || data.query.tag)) ||
      data.query.account ||
      data.query.from ||
      data.query.to ? (
        <div aria-label="Active filters" className="flex flex-wrap gap-1 px-3 pt-2">
          {(
            [
              {
                key: 'account',
                label: data.activeSet?.accounts.find((item) => item.id === data.query.account)
                  ?.displayName,
              },
              { key: 'kind', label: data.query.kind ? KIND_LABELS[data.query.kind] : undefined },
              {
                key: 'tag',
                label: data.query.tag
                  ? (data.tags.find((tag) => tag.id === data.query.tag)?.name ?? 'Tag')
                  : undefined,
              },
            ] as const
          )
            .filter((filter) => filter.label && (tab !== 'queue' || filter.key === 'account'))
            .map((filter) => (
              <Button
                key={filter.key}
                aria-label={`Remove ${filter.label} filter`}
                size="sm"
                variant="outline"
                onClick={() => setQuery({ [filter.key]: undefined })}
              >
                {filter.label}
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            ))}
          <Button size="sm" variant="ghost" onClick={() => setQuery(NO_FILTERS)}>
            Clear filters
          </Button>
        </div>
      ) : null}
      {canEdit && tab !== 'queue' ? <NewDraftMenu /> : null}
      {selected.length > 0 ? (
        <BulkBar
          key={scheduling ? 'series' : 'selection'}
          onDone={() => setSelected([])}
          onSchedulerClosed={() => setScheduling(false)}
          openScheduler={scheduling}
          selected={selected}
        />
      ) : null}
      <nav
        aria-label="Drafts"
        className="mt-2 min-h-0 flex-1 overflow-y-auto border-t border-border"
      >
        {tab === 'queue' ? (
          <QueueList />
        ) : libraryPending ? (
          <div aria-busy="true" className="grid gap-3 px-4 py-4" role="status">
            <span className="sr-only">Loading drafts</span>
            {[0, 1, 2].map((row) => (
              <Skeleton className="h-12 w-full" key={row} />
            ))}
          </div>
        ) : data.library.length === 0 ? (
          <div className="px-4 py-6 text-xs text-muted-foreground">
            {filtered
              ? 'Nothing matches these filters.'
              : {
                  all: 'Nothing in this profile yet. Start a draft above.',
                  archived: 'Nothing archived.',
                  drafts: 'No drafts in this profile. Start one above.',
                  failed: 'Nothing failed. Every post went out or is still on its way.',
                  posted: 'Nothing posted from this profile yet.',
                  queue: '',
                }[tab]}
            {filtered ? (
              <Button
                className="mt-2 block"
                size="sm"
                variant="outline"
                onClick={() => setQuery(NO_FILTERS)}
              >
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : (
          <ul>
            {tab === 'failed' && canPublish ? (
              <li className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
                <span>
                  {data.library.length} draft{data.library.length === 1 ? '' : 's'} with a failed
                  post.
                </span>
                <RetryAllFailed draftIds={data.library.map((draft) => draft.id)} />
              </li>
            ) : null}
            {/* Scheduling does not finish a draft, so a scheduled one still
                belongs here — but "Drafts" then stops meaning unfinished work.
                The list says how many are queued and hides them on request. */}
            {tab === 'drafts' && queuedInList > 0 ? (
              <li className="flex flex-wrap items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
                <span>
                  {queuedInList} of these {queuedInList === 1 ? 'is' : 'are'} already scheduled.
                </span>
                <Button
                  aria-pressed={hideQueued}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setHideQueued((current) => !current)}
                  size={null}
                  variant="ghost"
                >
                  {hideQueued ? 'Show them' : 'Hide them'}
                </Button>
              </li>
            ) : null}
            {shownLibrary.map((draft) => (
              <DraftRow
                now={now}
                active={draft.id === activeId}
                draft={draft}
                key={draft.id}
                onSelect={select}
                selected={selected.includes(draft.id)}
                selecting={selected.length > 0}
              />
            ))}
            {filtered && data.hasMore ? (
              <li className="px-4 py-3 text-xs text-muted-foreground" role="status">
                Showing the first 100. Narrow your filters to see the rest.
              </li>
            ) : null}
          </ul>
        )}
      </nav>
      {managingTags && data.activeSet ? (
        <TagManager onClose={() => setManagingTags(false)} setId={data.activeSet.id} />
      ) : null}
    </aside>
  )
}

/**
 * Search, and one menu for everything that narrows or orders the list: on every
 * tab the account and dates (a brand holds one active account per platform, so
 * the account is the platform too); on the lists also sort, tags and kind.
 */
function LibraryFilters({ onManageTags }: { onManageTags: () => void }) {
  const { data, setQuery } = useWrite()
  const workspaceId = useHydratedSession().data?.session.activeOrganizationId
  // Setting an account or dates counts toward the post-management metric.
  const filter = (next: Record<string, string | undefined>) => {
    if (Object.values(next).some(Boolean)) trackPostManagementUse(workspaceId, 'library_filter')
    setQuery(next)
  }
  const queue = data.query.tab === 'queue'
  const { account, from, to } = data.query
  const accounts = data.activeSet?.accounts ?? []
  const today = zonedDayKey(new Date(), data.activeSet?.timeZone ?? 'UTC')
  // The custom range stays open while one is set; presets live in the menu.
  const [customDates, setCustomDates] = React.useState(false)
  const preset = Object.entries(DATE_PRESETS).find(([, value]) => {
    const days = datePreset(value, today, data.weekStart)
    return days.from === from && days.to === to
  })?.[0]
  const [search, setSearch] = React.useState(data.query.q ?? '')
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  React.useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    setSearch(data.query.q ?? '')
  }, [data.query.q])
  const activeTag = data.tags.find((tag) => tag.id === data.query.tag)
  return (
    <>
    <div className="flex items-center gap-1.5 px-3 pt-2">
      <Input
        aria-label={SEARCH_LABELS[data.query.tab]}
        className="h-8 min-w-0 flex-1"
        onChange={(event) => {
          const value = event.target.value
          setSearch(value)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setQuery({ q: value.trim() || undefined }), 300)
        }}
        placeholder={SEARCH_LABELS[data.query.tab]}
        type="search"
        value={search}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Draft filters"
            className={cn(
              'h-8 rounded-md border border-border px-3 text-ui text-muted-foreground hover:text-foreground',
              (account ||
                from ||
                to ||
                (!queue && (activeTag || data.query.kind || data.query.sort))) &&
                'border-sky-400/50 text-sky-700 dark:text-sky-200'
            )}
            size={null}
            type="button"
            variant="custom"
          >
            Filters
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[70dvh] w-64 overflow-y-auto">
          <DropdownMenuLabel>Account</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => filter({ account: value || undefined })}
            value={account ?? ''}
          >
            <DropdownMenuRadioItem value="">All accounts</DropdownMenuRadioItem>
            {accounts.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>
                {item.displayName} · {platformLabel(item.platform)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Dates</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(label) => {
              if (label === 'custom') return setCustomDates(true)
              setCustomDates(false)
              filter(
                label
                  ? datePreset(DATE_PRESETS[label as keyof typeof DATE_PRESETS], today, data.weekStart)
                  : { from: undefined, to: undefined }
              )
            }}
            value={preset ?? (from || to || customDates ? 'custom' : '')}
          >
            <DropdownMenuRadioItem value="">Any time</DropdownMenuRadioItem>
            {Object.keys(DATE_PRESETS).map((label) => (
              <DropdownMenuRadioItem key={label} value={label}>
                {label}
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value="custom">Pick dates…</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {queue ? null : (
            <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Sort</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              setQuery({ sort: value === 'updated_desc' ? undefined : value })
            }
            value={data.query.sort ?? 'updated_desc'}
          >
            {SORTS.map((item) => (
              <DropdownMenuRadioItem key={item.sort} value={item.sort}>
                {item.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {/* Tags are an experiment (RFC 024): shown only when it is on. */}
          {data.experiments.tags ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Tags</DropdownMenuLabel>
              {data.tags.length === 0 ? (
                <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
              ) : (
                data.tags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    checked={tag.id === data.query.tag}
                    key={tag.id}
                    onCheckedChange={(checked) => setQuery({ tag: checked ? tag.id : undefined })}
                  >
                    <TagChip tag={tag} />
                  </DropdownMenuCheckboxItem>
                ))
              )}
              <DropdownMenuItem onSelect={onManageTags}>Manage tags…</DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Kind</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) => setQuery({ kind: value || undefined })}
            value={data.query.kind ?? ''}
          >
            <DropdownMenuRadioItem value="">Every kind</DropdownMenuRadioItem>
            {(Object.keys(KIND_LABELS) as DraftKind[]).map((kind) => (
              <DropdownMenuRadioItem key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {activeTag && !queue ? (
        <Button
          aria-label={`Clear the ${activeTag.name} filter`}
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setQuery({ tag: undefined })}
          size={null}
          type="button"
          variant="custom"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      ) : null}
    </div>
    {customDates || (!preset && (from || to)) ? (
      <div className="px-3 pt-2">
        <DateRangePicker
          aria-label="Dates"
          className="h-7 w-full min-w-0 text-xs"
          onChange={(range) => filter(range)}
          value={{ from: from ?? '', to: to ?? '' }}
        />
      </div>
    ) : null}
    </>
  )
}

/** What a new draft of each kind needs before it can be written. */
type NewKind = { kind: DraftKind; label: string; needs?: 'url' | 'source' }

/**
 * New draft, and the kinds the set's platforms take: a post, an X article,
 * a quote, a reply, or a repurposed post. A draft made while a tag filter is
 * on carries that tag.
 */
export function NewDraftMenu({ compact = false }: { compact?: boolean }) {
  const router = useWriteRouter()
  const { mod } = useKeys()
  const { beforeLeaveRef, data } = useWrite()
  const [creating, setCreating] = React.useState(false)
  const [asking, setAsking] = React.useState<NewKind | null>(null)
  const channels = new Set(data.activeSet?.accounts.map((account) => account.channel) ?? [])
  const kinds: NewKind[] = [
    ...(channels.has('x') ? [{ kind: 'article' as const, label: 'X Article' }] : []),
    ...(channels.has('x') ||
    channels.has('linkedin') ||
    channels.has('bluesky') ||
    channels.has('mastodon')
      ? [{ kind: 'quote' as const, label: 'Quote a post', needs: 'url' as const }]
      : []),
    ...(channels.has('x')
      ? [{ kind: 'reply' as const, label: 'Reply to an X post', needs: 'url' as const }]
      : []),
    { kind: 'repurpose', label: 'Repurpose published content', needs: 'source' },
  ]
  const startDraft = useNewDraft()
  const create = async (kind: DraftKind, target?: { sourceDraftId?: string; url?: string }) => {
    setCreating(true)
    try {
      // A plain post opens blank and waits for its first word; the other kinds carry a choice worth keeping.
      if (kind === 'standard' && !target) return startDraft()
      await createWritingDraft(
        {
          channelConnectionIds: carriedChannels(data.activeSet),
          kind,
          socialSetId: data.activeSet?.id,
          tagIds: data.experiments.tags && data.query.tag ? [data.query.tag] : undefined,
          target,
        },
        (id) => router.push(draftHref(id, data.activeSet?.id)),
        beforeLeaveRef.current ?? undefined
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The draft could not be created.')
    } finally {
      setCreating(false)
    }
  }
  return (
    // A secondary split button: Schedule is the page's one primary action.
    <div
      className={cn('flex items-center', compact ? '' : 'mx-3 mt-2')}
      data-tour-id="write-new-draft"
    >
      <Button
        className="flex h-8 flex-1 items-center gap-2 rounded-l-md border border-border px-3 text-ui font-medium text-foreground hover:bg-foreground/[0.04] disabled:opacity-50"
        data-testid="new-draft"
        disabled={creating}
        onClick={() => void create('standard')}
        size={null}
        title={`New draft (${mod}.)`}
        type="button"
        variant="custom"
      >
        <Add01Icon aria-hidden className="size-4" />
        New draft
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="New draft of another kind"
            className="grid h-8 place-items-center rounded-r-md border border-l-0 border-border pe-2.5 ps-2 text-foreground hover:bg-foreground/[0.04]"
            size={null}
            type="button"
            variant="custom"
          >
            <CaretDownIcon aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className={MENU_GROUP}>Every platform</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void create('standard')}>
            Post or thread
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAsking(kinds[kinds.length - 1])}>
            Repurpose published content
          </DropdownMenuItem>
          {kinds.some((item) => item.kind === 'quote') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className={MENU_GROUP}>X, LinkedIn, Bluesky and Mastodon</DropdownMenuLabel>
              {kinds
                .filter((item) => item.kind === 'quote')
                .map((item) => (
                  <DropdownMenuItem key={item.kind} onSelect={() => setAsking(item)}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
            </>
          ) : null}
          {channels.has('x') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className={MENU_GROUP}>X only</DropdownMenuLabel>
              {kinds
                .filter((item) => item.kind === 'article' || item.kind === 'reply')
                .map((item) => (
                  <DropdownMenuItem
                    key={item.kind}
                    onSelect={() =>
                      item.kind === 'article' ? void create('article') : setAsking(item)
                    }
                  >
                    {item.label}
                  </DropdownMenuItem>
                ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {asking ? (
        <TargetDialog
          kind={asking}
          onClose={() => setAsking(null)}
          onCreate={(target) => {
            setAsking(null)
            void create(asking.kind, target)
          }}
        />
      ) : null}
    </div>
  )
}

const POST_URL =
  /^https:\/\/(?:www\.|mobile\.)?(?:(?:x|twitter)\.com\/[^/]+\/status\/\d+|linkedin\.com\/.*urn:li:(?:share|ugcPost|activity):\d+|bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9._~:-]+)/

/** Ask for the post a quote or reply answers, or the published post a draft repurposes. */
export function TargetDialog({
  kind,
  onClose,
  onCreate,
}: {
  kind: NewKind
  onClose: () => void
  onCreate: (target: { sourceDraftId?: string; url?: string }) => void
}) {
  const { data } = useWrite()
  const [url, setUrl] = React.useState('')
  const [posted, setPosted] = React.useState<{ id: string; title: string }[]>([])
  React.useEffect(() => {
    if (kind.needs !== 'source') return
    const query = new URLSearchParams({ view: 'posted', limit: '50' })
    if (data.activeSet) query.set('socialSetId', data.activeSet.id)
    void fetch(`/api/v1/content-drafts?${query}`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((body: { items: { id: string; title: string }[] }) => setPosted(body.items))
      .catch(() => setPosted([]))
  }, [data.activeSet, kind.needs])
  const valid =
    kind.needs === 'source'
      ? /^https:\/\//.test(url)
      : POST_URL.test(url.trim()) ||
        (kind.kind === 'quote' &&
          /^https:\/\/[^/@:]+\/(?:@[^/]+\/|users\/[^/]+\/statuses\/|statuses\/)\d+$/.test(
            url.trim()
          ))
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{kind.label}</DialogTitle>
          <DialogDescription>
            {kind.needs === 'source'
              ? 'Start from a post this profile published, or paste the URL of any published post.'
              : 'Paste the post’s URL. It is stored as the draft’s target, not as text in the post.'}
          </DialogDescription>
        </DialogHeader>
        {kind.needs === 'source' && posted.length > 0 ? (
          <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
            {posted.map((draft) => (
              <li key={draft.id}>
                <Button
                  className="w-full truncate px-3 py-2 text-left text-sm hover:bg-foreground/[0.04]"
                  onClick={() => onCreate({ sourceDraftId: draft.id })}
                  size={null}
                  type="button"
                  variant="custom"
                >
                  {draft.title}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <Input
          aria-label="Post URL"
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
          placeholder={kind.kind === 'reply' ? 'https://x.com/name/status/123' : 'https://…'}
          value={url}
        />
        {url && !valid ? (
          <p className="text-xs text-amber-700 dark:text-amber-300" role="alert">
            {kind.kind === 'reply'
              ? 'Use the URL of an X post (x.com/…/status/…).'
              : 'Use the URL of an X post or a LinkedIn post.'}
          </p>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={!valid} onClick={() => onCreate({ url: url.trim() })} type="button">
            Start writing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A draft's line: its text, title, destinations, time, status and tags. */
function DraftRow({
  now,
  active,
  draft,
  onSelect,
  selected,
  selecting,
}: {
  now?: number
  active: boolean
  draft: LibraryDraft
  onSelect: (id: string, range: boolean) => void
  selected: boolean
  selecting: boolean
}) {
  const { data, saved, canEdit } = useWrite()
  const hydrated = useHydrated()
  const [showingLinks, setShowingLinks] = React.useState(false)
  const shown = { ...draft, ...saved[draft.id] }
  const destinations = (data.activeSet?.accounts ?? []).filter((connection) =>
    shown.channelConnectionIds.includes(connection.id)
  )
  const tags = data.tags.filter((tag) => draft.tagIds.includes(tag.id))
  return (
    <li
      className={cn(
        'group/row relative border-b border-l-2 border-b-white/[0.04] transition-colors',
        active
          ? 'border-l-foreground bg-foreground/[0.04]'
          : 'border-l-transparent hover:bg-foreground/[0.02]',
        selected && 'bg-sky-400/[0.06]'
      )}
      data-selecting={selecting || undefined}
      data-testid="draft-row"
    >
      <Link
        aria-current={active ? 'page' : undefined}
        className="block px-4 py-2.5 pr-10"
        href={draftHref(draft.id, data.activeSet?.id, undefined, data.query.tab)}
        draggable={canEdit && draft.status === 'draft' && draft.queuedPosts === 0}
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-shots-library-draft', draft.id)
          event.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(event) => {
          if (event.shiftKey || selecting) {
            event.preventDefault()
            onSelect(draft.id, event.shiftKey)
          }
        }}
      >
        <p className="flex items-start gap-1.5">
          {selecting ? (
            <Checkbox
              aria-label={`Select ${draftName(shown)}`}
              checked={selected}
              className="mt-0.5"
              tabIndex={-1}
            />
          ) : null}
          {shown.pinned ? (
            <PinIcon
              aria-label="Pinned"
              className="mt-0.5 size-3.5 shrink-0 text-sky-700 dark:text-sky-300"
            />
          ) : null}
          <span className="line-clamp-2 text-[13px] leading-snug text-foreground">
            {shown.excerpt || <span className="text-muted-foreground">{draftName(shown)}</span>}
          </span>
        </p>
        <p className="mt-1 flex items-center gap-2 text-caption text-[var(--fg-tertiary)]">
          <span className="min-w-0 flex-1 truncate">
            {draft.kind !== 'standard' ? (
              <span className="mr-1 text-muted-foreground">{KIND_LABELS[draft.kind]} ·</span>
            ) : null}
            {/* The first line names the draft; a title shows only when someone gave one. */}
            {shown.title && shown.title !== 'Untitled draft' ? shown.title : null}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {destinations.map((connection) => {
              const name = `${CHANNEL_META[connection.channel].label}: ${connection.displayName ?? connection.handle ?? 'account'}`
              return (
                <span aria-label={name} key={connection.id} role="img" title={name}>
                  <ChannelIcon channel={connection.channel} />
                </span>
              )
            })}
          </span>
          {/* A status line below already dates a post that went out or failed. */}
          {draft.attentionPosts > 0 || draft.publishedPosts > 0 ? null : (
            <span className="shrink-0" title="Last edited">
              {hydrated ? `Edited ${since(shown.updatedAt, now)}` : null}
            </span>
          )}
        </p>
        <RowStatus draft={draft} />
        {tags.length > 0 ? (
          <p className="mt-1.5 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </p>
        ) : null}
      </Link>
      {/* Where it went live, on the tab that is about what went out. Outside the
          row's link: a control inside an anchor is not reachable by keyboard. */}
      {data.query.tab === 'posted' && draft.publishedPosts > 0 ? (
        <Button
          aria-expanded={showingLinks}
          className="mx-4 mb-2 h-6 px-0 text-[11px] text-sky-700 underline dark:text-sky-300"
          onClick={() => setShowingLinks((current) => !current)}
          size={null}
          variant="ghost"
        >
          {showingLinks ? 'Hide the links' : 'Where it went live'}
        </Button>
      ) : null}
      {showingLinks ? <DraftPostLinks draftId={draft.id} /> : null}
      <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <DraftRowMenu draft={shown} onSelect={() => onSelect(draft.id, false)} />
      </div>
    </li>
  )
}

/** A status's date in a list row: "Nov 3". */
const ROW_DAY: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }

/** A row's status line: scheduled, planned, posted, needs attention, in review, shared. */
function RowStatus({ draft }: { draft: LibraryDraft }) {
  // Times read in the set's scheduling zone, as the Plan calendar shows them.
  const timeZone = useWrite().data.activeSet?.timeZone
  const parts: React.ReactNode[] = []
  const attention = listedAttention(draft)
  if (attention) {
    parts.push(
      <span
        className={
          attention.state === 'Failed'
            ? 'text-red-700 dark:text-red-300'
            : 'text-amber-700 dark:text-amber-300'
        }
        key="attention"
      >
        {stateLabel(attention.state, attention.count, attention.total)}
        {draft.attentionAt ? (
          <>
            {' '}
            <LocalTime options={ROW_DAY} value={draft.attentionAt} zone={timeZone} />
          </>
        ) : null}
      </span>
    )
  }
  // The editor's words, in its order: a post whose time passed before it
  // started, then one publishing now, then the next one scheduled.
  const overdue = draft.nextPostAt && postState('SCHEDULED', draft.nextPostAt) === 'Overdue'
  if (draft.nextPostAt && (overdue || draft.publishingPosts === 0)) {
    parts.push(
      <span
        className={overdue ? 'text-amber-700 dark:text-amber-300' : 'text-sky-700 dark:text-sky-300'}
        key="next"
      >
        {overdue ? 'Overdue' : 'Scheduled'}{' '}
        <LocalTime value={draft.nextPostAt} zone={timeZone} />
      </span>
    )
  } else if (draft.publishingPosts > 0) {
    parts.push(
      <span className="text-sky-700 dark:text-sky-300" key="next">
        Publishing
      </span>
    )
  } else if (draft.plannedFor) {
    parts.push(
      <span className="text-violet-700 dark:text-violet-300" key="planned">
        {draft.status === 'archived' ? 'Previously planned' : 'Planned'}{' '}
        <LocalTime value={draft.plannedFor} zone={timeZone} />
      </span>
    )
  }
  // Sent to the network's app as a draft: the person finishes it there.
  if (draft.sentToAppPosts > 0)
    parts.push(
      <span className="text-violet-700 dark:text-violet-300" key="app">
        Sent to the app to finish there
        {draft.sentToAppPosts > 1 ? ` · ${draft.sentToAppPosts} accounts` : ''}
      </span>
    )
  if (draft.publishedPosts > 0)
    parts.push(
      <span key="live">
        Published
        {draft.publishedPosts > 1 ? ` to ${draft.publishedPosts} accounts` : ''}
        {draft.lastPublishedAt ? (
          <>
            {' '}
            <LocalTime options={ROW_DAY} value={draft.lastPublishedAt} zone={timeZone} />
          </>
        ) : null}
      </span>
    )
  if (draft.reviewStatus === 'pending')
    parts.push(
      <span className="text-amber-700 dark:text-amber-300" key="review">
        In review
      </span>
    )
  if (draft.shared) parts.push(<span key="shared">Public link on</span>)
  if (parts.length === 0) return null
  return (
    <p className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
      {parts.map((part, index) => (
        <React.Fragment key={index}>{part}</React.Fragment>
      ))}
    </p>
  )
}

/**
 * A row's actions. Deleting asks first; sharing a public link asks first and
 * says it gives anyone with the link read and comment access.
 */
export function DraftRowMenu({ draft, onSelect }: { draft: LibraryDraft; onSelect?: () => void }) {
  const router = useWriteRouter()
  const { mod } = useKeys()
  const { activeId, archiveRef, beforeLeaveRef, canEdit, data, hideDraft, showSaved } = useWrite()
  const [confirm, setConfirm] = React.useState<'delete' | 'share' | null>(null)
  const [copyTo, setCopyTo] = React.useState<string | null>(null)
  const act = async (work: () => Promise<unknown>, done: string, refresh = true) => {
    try {
      await work()
      toast.success(done)
      if (refresh) router.refresh()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.')
      return false
    }
  }
  const internalLink = () => `${window.location.origin}${draftHref(draft.id, data.activeSet?.id)}`
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Actions for ${draftName(draft)}`}
            className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground hover:text-foreground"
            size={null}
            type="button"
            variant="custom"
          >
            <DotsThreeIcon aria-hidden className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {canEdit ? (
            <>
              <DropdownMenuItem
                onSelect={() =>
                  void act(
                    async () => {
                      const copy = await writeApi.duplicate(draft.id)
                      router.push(draftHref(copy.draft.id, data.activeSet?.id))
                    },
                    'Duplicated. The copy has no schedule, share link or comments.',
                    // Opening the copy loads a fresh list; a refresh as well would load it twice.
                    false
                  )
                }
              >
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Copy to profile</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-60">
                  {data.sets
                    .filter((set) => set.id !== data.activeSet?.id)
                    .map((set) => (
                      <DropdownMenuItem
                        className="flex items-center gap-2"
                        key={set.id}
                        onSelect={() => setCopyTo(set.id)}
                      >
                        <SetDot color={set.color} />
                        <span className="truncate">{set.name}</span>
                      </DropdownMenuItem>
                    ))}
                  {data.sets.length < 2 ? (
                    <DropdownMenuItem disabled>No other set</DropdownMenuItem>
                  ) : null}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                onSelect={() => {
                  // The pin shows at once; a refusal puts it back.
                  showSaved({ id: draft.id, pinned: !draft.pinned })
                  void act(
                    () => writeApi.properties(draft.id, { pinned: !draft.pinned }),
                    draft.pinned ? 'Unpinned.' : 'Pinned to the top.'
                  ).then((done) => done || showSaved({ id: draft.id, pinned: draft.pinned }))
                }}
              >
                {draft.pinned ? 'Unpin draft' : 'Pin draft'}
                <DropdownMenuShortcut>{mod}⇧P</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  const status = draft.status === 'archived' ? 'draft' : 'archived'
                  // The open draft goes through its composer, which saves first and
                  // keeps the version its next autosave is based on.
                  if (draft.id === activeId && archiveRef.current)
                    return void archiveRef.current(status)
                  void act(
                    async () => {
                      const fresh = await draftsApi.get(draft.id)
                      return draftsApi.save(draft.id, { baseVersion: fresh.version, status })
                    },
                    status === 'draft' ? 'Restored from archive.' : 'Archived.'
                  )
                }}
              >
                {draft.status === 'archived' ? 'Restore from archive' : 'Archive'}
              </DropdownMenuItem>
              {data.experiments.tags ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Tag this draft</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56">
                    {data.tags.length === 0 ? (
                      <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
                    ) : null}
                    {data.tags.map((tag) => {
                      const on = draft.tagIds.includes(tag.id)
                      return (
                        <DropdownMenuCheckboxItem
                          checked={on}
                          key={tag.id}
                          onCheckedChange={() =>
                            void act(
                              () =>
                                writeApi.properties(
                                  draft.id,
                                  on ? { removeTagIds: [tag.id] } : { addTagIds: [tag.id] }
                                ),
                              on ? `Removed ${tag.name}.` : `Tagged ${tag.name}.`
                            )
                          }
                        >
                          <TagChip tag={tag} />
                        </DropdownMenuCheckboxItem>
                      )
                    })}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
            </>
          ) : null}
          {onSelect ? (
            <DropdownMenuItem onSelect={onSelect}>
              Select multiple
              <DropdownMenuShortcut>⇧Click</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onSelect={() => router.push(draftHref(draft.id, data.activeSet?.id, 'backups'))}
          >
            View automatic backups
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(internalLink())
              toast.success(
                'Internal link copied. Only members who can see this profile can open it.'
              )
            }}
          >
            Copy internal link
          </DropdownMenuItem>
          {draft.publishedPosts > 0 ? (
            <DropdownMenuItem
              onSelect={() =>
                void (async () => {
                  try {
                    const result = await draftsApi.posts(draft.id)
                    const urls = result.posts
                      .filter((post) => post.status === 'PUBLISHED' && post.url)
                      .map((post) => post.url)
                    if (!urls.length) throw new Error('Published links are not available yet.')
                    await navigator.clipboard.writeText(urls.join('\n'))
                    toast.success('Published post links copied.')
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : 'The links could not be copied.'
                    )
                  }
                })()
              }
            >
              Copy published links
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            <DropdownMenuItem onSelect={() => setConfirm('share')}>
              Share & copy public link…
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            <>
              <DropdownMenuSeparator />
              {draft.status === 'archived' ? (
                <DropdownMenuItem
                  onSelect={() =>
                    void act(async () => {
                      const current = await draftsApi.get(draft.id)
                      await draftsApi.save(draft.id, {
                        baseVersion: current.version,
                        status: 'draft',
                      })
                    }, 'Restored from archive.')
                  }
                >
                  Restore draft
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="text-red-700 dark:text-red-300"
                onSelect={() => setConfirm('delete')}
              >
                Delete…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog onOpenChange={(open) => !open && setConfirm(null)} open={confirm !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'delete' ? `Delete “${draftName(draft)}”?` : 'Turn on the public link?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'delete'
                ? 'The draft and its backups are deleted. A draft with scheduled or published posts cannot be deleted; archive it instead.'
                : 'Anyone with the link will be able to read this draft and comment on it, without signing in. You can turn the link off at any time, and it stops working at once.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirm === 'delete' ? 'bg-red-500 text-white hover:bg-red-400' : undefined
              }
              onClick={() =>
                confirm === 'delete'
                  ? void act(
                      async () => {
                        await beforeLeaveRef.current?.()
                        await draftsApi.remove(draft.id)
                        hideDraft(draft.id)
                        if (activeId === draft.id) router.replace('/publish')
                        else router.refresh()
                      },
                      'Draft deleted.',
                      false
                    )
                  : void act(async () => {
                      const shared = await draftsApi.share(draft.id, true)
                      if (shared.shareToken) {
                        await navigator.clipboard.writeText(
                          `${window.location.origin}/d/${shared.shareToken}`
                        )
                      }
                    }, 'Public link on and copied.')
              }
            >
              {confirm === 'delete' ? 'Delete draft' : 'Turn on and copy'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {copyTo ? (
        <CopyDialog
          draftId={draft.id}
          onClose={() => setCopyTo(null)}
          setName={data.sets.find((set) => set.id === copyTo)?.name ?? ''}
          socialSetId={copyTo}
        />
      ) : null}
    </>
  )
}

/** Copy a draft into another set, choosing what happens to its tags. */
function CopyDialog({
  draftId,
  onClose,
  setName,
  socialSetId,
}: {
  draftId: string
  onClose: () => void
  setName: string
  socialSetId: string
}) {
  const router = useWriteRouter()
  const [busy, setBusy] = React.useState(false)
  const copy = async (tagMode: 'match' | 'drop') => {
    setBusy(true)
    try {
      const result = await writeApi.copy(draftId, { socialSetId, tagMode })
      const dropped = result.dropped.map((item) =>
        item.replace(/^platform:/, '').replace(/^tag:/, '#')
      )
      toast.success(
        `Copied to ${setName}.${dropped.length > 0 ? ` Left behind: ${dropped.join(', ')}.` : ''}`
      )
      onClose()
      router.push(draftHref(result.draft.id, socialSetId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The draft could not be copied.')
      setBusy(false)
    }
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Copy to {setName}</DialogTitle>
          <DialogDescription>
            The copy is a new draft that posts as {setName}’s accounts on the same platforms. Its
            schedule, share link, comments and approval stay with the original. Each set has its own
            tags.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button disabled={busy} onClick={() => void copy('drop')} type="button" variant="outline">
            Copy without tags
          </Button>
          <Button disabled={busy} onClick={() => void copy('match')} type="button">
            Copy, matching tags by name
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Actions on several selected drafts. */
function BulkBar({
  onDone,
  openScheduler = false,
  onSchedulerClosed,
  selected,
}: {
  onDone: () => void
  /** A run that just arrived from a split paste opens its scheduler at once. */
  openScheduler?: boolean
  onSchedulerClosed?: () => void
  selected: string[]
}) {
  const router = useWriteRouter()
  const { activeId, beforeLeaveRef, canEdit, data, hideDraft, canPublish } = useWrite()
  const [scheduling, setScheduling] = React.useState(openScheduler && canPublish)
  const [confirm, setConfirm] = React.useState(false)
  const [progress, setProgress] = React.useState<number | null>(null)
  const run = async (label: string, work: (id: string) => Promise<unknown>) => {
    if (progress !== null) return
    try {
      await beforeLeaveRef.current?.()
    } catch {
      return
    }
    setProgress(0)
    let removedActive = false
    // One at a time: a duplicate points at its source, and deleting both at
    // once can race on that link.
    let failed = 0
    for (const id of selected) {
      try {
        await work(id)
        if (label === 'Deleted') {
          hideDraft(id)
          if (id === activeId) removedActive = true
        }
      } catch {
        failed += 1
      }
      setProgress((current) => (current ?? 0) + 1)
    }
    if (failed > 0) toast.error(`${label}: ${failed} of ${selected.length} did not change.`)
    else toast.success(`${label}: ${selected.length} drafts.`)
    setProgress(null)
    onDone()
    if (removedActive)
      router.replace(data.activeSet ? `/publish?set=${data.activeSet.id}` : '/publish')
    else router.refresh()
  }
  const version = (id: string) => data.library.find((draft) => draft.id === id)
  return (
    <div
      className="mx-3 mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-sky-400/30 bg-sky-400/[0.05] px-2 py-1.5 text-xs"
      aria-busy={progress !== null}
      role="toolbar"
      aria-label="Selected drafts"
    >
      {scheduling && (
        <BulkScheduleDialog
          initialMode={openScheduler ? 'spread' : 'queue'}
          selected={selected}
          onClose={() => {
            setScheduling(false)
            onSchedulerClosed?.()
          }}
        />
      )}
      {canPublish && (
        <Button size="sm" variant="ghost" onClick={() => setScheduling(true)}>
          Schedule
        </Button>
      )}
      <span className="mr-auto text-sky-700 dark:text-sky-200">
        {progress === null
          ? `${selected.length} selected`
          : `${progress} of ${selected.length} completed…`}
      </span>
      {/* Platforms belong to the draft, so a run's destinations change here
          rather than on the commitments the queue already holds. */}
      {canEdit && (data.activeSet?.accounts.length ?? 0) > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={progress !== null} size="sm" type="button" variant="ghost">
              Platforms
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {(data.activeSet?.accounts ?? []).map((account) => (
              <React.Fragment key={account.id}>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(`Added ${CHANNEL_META[account.channel].label}`, async (id) => {
                      const fresh = await draftsApi.get(id)
                      return draftsApi.save(id, {
                        baseVersion: fresh.version,
                        channelConnectionIds: [
                          ...new Set([...fresh.channelConnectionIds, account.id]),
                        ],
                      })
                    })
                  }
                >
                  Add {CHANNEL_META[account.channel].label}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    void run(`Removed ${CHANNEL_META[account.channel].label}`, async (id) => {
                      const fresh = await draftsApi.get(id)
                      return draftsApi.save(id, {
                        baseVersion: fresh.version,
                        channelConnectionIds: fresh.channelConnectionIds.filter(
                          (entry) => entry !== account.id
                        ),
                      })
                    })
                  }
                >
                  Remove {CHANNEL_META[account.channel].label}
                </DropdownMenuItem>
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Button
        disabled={progress !== null}
        onClick={() => void run('Pinned', (id) => writeApi.properties(id, { pinned: true }))}
        size="sm"
        type="button"
        variant="ghost"
      >
        Pin
      </Button>
      <Button
        disabled={progress !== null}
        onClick={() =>
          void run('Archived', async (id) => {
            const fresh = await draftsApi.get(id)
            return draftsApi.save(id, { baseVersion: fresh.version, status: 'archived' })
          })
        }
        size="sm"
        type="button"
        variant="ghost"
      >
        Archive
      </Button>
      <Button
        disabled={progress !== null}
        className="text-red-700 dark:text-red-300"
        onClick={() => setConfirm(true)}
        size="sm"
        type="button"
        variant="ghost"
      >
        Delete
      </Button>
      <Button
        disabled={progress !== null}
        aria-label="Clear selection"
        onClick={onDone}
        size="sm"
        type="button"
        variant="ghost"
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
      <AlertDialog onOpenChange={setConfirm} open={confirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selected.length} drafts?</AlertDialogTitle>
            <AlertDialogDescription>
              Drafts with scheduled or published posts are kept; archive those instead.
              {selected.some((id) => version(id)?.publishedPosts)
                ? ' Some selected drafts have live posts.'
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-500 text-white hover:bg-red-400"
              onClick={() => void run('Deleted', (id) => draftsApi.remove(id))}
            >
              Delete drafts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The queue: the next seven days in the brand's zone, each with its queued
 * posts, planned drafts and free weekly slots, then anything later. An empty
 * slot is a prompt to write: "+ New" opens a draft set to that time. Planned
 * drafts never publish by themselves.
 */
function QueueList() {
  const router = useWriteRouter()
  const { beforeLeaveRef, canEdit, canPublish, data, setQuery } = useWrite()
  const set = data.activeSet
  const zone = set?.timeZone ?? 'UTC'
  const hydrated = useHydrated()
  // Only scheduled posts can be selected: a planned draft has no commitment to
  // move, swap or take out of the queue.
  const [picked, setPicked] = React.useState<string[]>([])
  const [dragging, setDragging] = React.useState<string | null>(null)
  const selectable = React.useMemo(
    () => new Map(data.queue.filter((item) => item.kind === 'scheduled').map((item) => [item.id, item])),
    [data.queue]
  )
  const chosen = picked.flatMap((id) => {
    const row = selectable.get(id)
    return row ? [row] : []
  })
  const warnings = React.useMemo(
    () => queueWarnings([...selectable.values()], { minutesApart: 30 }),
    [selectable]
  )
  // Read over the whole queue, so a run spread across two days is one run on
  // both of them rather than two groups, or a group and a stray post. For the
  // same reason the collapsed runs are held here, not per day.
  const runs = React.useMemo(() => queueRuns(data.queue), [data.queue])
  const [collapsed, setCollapsed] = React.useState<string[]>([])
  const onCollapse = (name: string, shut: boolean) =>
    setCollapsed((current) =>
      shut ? [...new Set([...current, name])] : current.filter((item) => item !== name)
    )
  const toggleRow = (id: string, on: boolean) =>
    setPicked((current) => (on ? [...new Set([...current, id])] : current.filter((item) => item !== id)))
  // Dropping one queued post on another exchanges their times, which is what
  // editing the order of a written sequence actually means.
  const swap = (fromId: string, toId: string) => {
    if (fromId === toId) return
    void draftsApi
      .swapPosts(fromId, toId)
      .then(() => {
        toast.success('Swapped their times.')
        router.refresh()
      })
      .catch((error: unknown) =>
        toast.error(
          error instanceof Error ? error.message : 'Those two posts could not be swapped.'
        )
      )
  }
  // The backend exchanges two commitments on one account, so a row only takes
  // a drop from a post that shares its account: offering more would be an
  // invitation to a refusal.
  const dragged = dragging ? selectable.get(dragging) : undefined
  const rowProps = (item: WriteLibrary['queue'][number]) => ({
    accepts: Boolean(
      dragged &&
        dragged.id !== item.id &&
        item.kind === 'scheduled' &&
        item.accountIds.some((id) => dragged.accountIds.includes(id))
    ),
    dragging: dragging === item.id,
    onDragEnd: () => setDragging(null),
    onDragStart: () => setDragging(item.id),
    onDrop: (fromId: string) => swap(fromId, item.id),
    onToggle: canPublish && item.kind === 'scheduled' ? toggleRow : undefined,
    selected: picked.includes(item.id),
    warned: warnings.some((warning) => warning.ids.includes(item.id)),
  })
  // A filter hides posts that fill slots, so a filtered queue lists its posts and no free slots.
  const filtered = Boolean(data.query.account || data.query.from || data.query.to || data.query.q)
  // Slots depend on the clock, so they are read after hydration, as LocalTime does.
  const days = React.useMemo(
    () => (hydrated ? queueDays(filtered ? [] : (set?.postingSlots ?? []), zone, data.queue) : []),
    [data.queue, filtered, hydrated, set?.postingSlots, zone]
  )
  const shown = new Set(days.flatMap((day) => day.items.map((item) => item.id)))
  // Overdue and unconfirmed posts from before today lead: they need a look first.
  const first = days[0]?.day
  const earlier = first
    ? data.queue.filter((item) => !shown.has(item.id) && wallTime(new Date(item.at), zone) < first)
    : []
  const later = data.queue.filter((item) => !shown.has(item.id) && !earlier.includes(item))
  const free = days.reduce((total, day) => total + day.free.length, 0)
  const total = days.reduce((sum, day) => sum + day.slots, 0)
  // Two different counts, so the header never reads as "nothing is scheduled".
  const scheduledCount = data.queue.filter((item) => item.kind === 'scheduled').length
  const plannedCount = data.queue.length - scheduledCount
  const newAt = (day: string, time: string) =>
    void createWritingDraft(
      { channelConnectionIds: carriedChannels(set), socialSetId: set?.id },
      (id) => {
        const href = draftHref(id, set?.id)
        router.push(`${href}${href.includes('?') ? '&' : '?'}day=${day}&time=${time}`)
      },
      beforeLeaveRef.current ?? undefined
    ).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'The draft could not be created.')
    )
  const horizon = (
    <p className="px-4 pt-3 text-xs text-muted-foreground">
      Free slots for the next 7 days, and posts for the next 60 days.{' '}
      <Link
        className="underline"
        href={`/publish/calendar${set ? `?set=${encodeURIComponent(set.id)}` : ''}`}
      >
        See the calendar
      </Link>{' '}
      for later ones.
    </p>
  )
  // The server and the first client render agree: the plain list, soonest first.
  if (!hydrated)
    return (
      <ul data-testid="queue">
        <li>{horizon}</li>
        {data.queue.map((item) => (
          <QueueItem item={item} key={item.id} />
        ))}
      </ul>
    )
  return (
    <div data-testid="queue">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1 text-[11px] text-muted-foreground">
        {/* What is queued leads: recurring slots are a separate, smaller fact. */}
        <span data-testid="queue-goal">
          {`${scheduledCount} ${scheduledCount === 1 ? 'post' : 'posts'} scheduled`}
          {plannedCount > 0
            ? ` · ${plannedCount} planned`
            : ''}
          {' · '}
          {filtered
            ? 'filtered, so free slots are hidden'
            : total > 0
              ? `${total - free} of ${total} recurring slots used in the next 7 days`
              : 'no recurring slots yet'}
          {' · '}
          {zone.replaceAll('_', ' ')}
        </span>
        {set ? (
          <Link
            className="underline underline-offset-2 hover:text-foreground"
            href={socialSetHref(set.id, 'scheduling')}
          >
            Edit schedule
          </Link>
        ) : null}
      </div>
      {horizon}
      <QueueWarnings onSelect={setPicked} warnings={warnings} />
      {chosen.length > 0 ? (
        <QueueBulkBar
          onDone={() => {
            setPicked([])
            router.refresh()
          }}
          rows={chosen}
          zone={zone}
        />
      ) : null}
      {earlier.length > 0 ? (
        <section aria-label="Needs a look">
          <h3 className="px-4 pt-3 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Needs a look
          </h3>
          <QueueRows
            collapsed={collapsed}
            items={earlier}
            onCollapse={onCollapse}
            onPick={setPicked}
            rowProps={rowProps}
            runs={runs}
            zone={zone}
          />
        </section>
      ) : null}
      {days.map(({ day, free: open, items }) =>
        items.length === 0 && open.length === 0 ? null : (
          <section aria-label={day} key={day}>
            <h3 className="px-4 pt-3 text-[11px] font-medium text-muted-foreground">
              <LocalTime
                options={{ day: 'numeric', month: 'short', timeZone: 'UTC', weekday: 'short' }}
                value={`${day}T12:00:00Z`}
              />
            </h3>
            <QueueRows
              collapsed={collapsed}
              day={day}
              free={open}
              items={items}
              onCollapse={onCollapse}
              onNew={canEdit ? (clock) => newAt(day, clock) : undefined}
              onPick={setPicked}
              rowProps={rowProps}
              runs={runs}
              zone={zone}
            />
          </section>
        )
      )}
      {later.length > 0 ? (
        <section aria-label="Later">
          <h3 className="px-4 pt-3 text-[11px] font-medium text-muted-foreground">Later</h3>
          <QueueRows
            collapsed={collapsed}
            items={later}
            onCollapse={onCollapse}
            onPick={setPicked}
            rowProps={rowProps}
            runs={runs}
            zone={zone}
          />
        </section>
      ) : null}
      {data.queue.length === 0 && free === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          {filtered
            ? 'Nothing in the queue matches these filters.'
            : 'Nothing queued or planned for this profile. Add weekly slots in Edit schedule, or schedule a draft.'}
          {filtered ? (
            <Button
              className="mt-2 block"
              size="sm"
              variant="outline"
              onClick={() => setQuery(NO_FILTERS)}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A wall-clock "HH:MM" as a person reads it, without a date or zone. */
function ClockLabel({ time }: { time: string }) {
  const [hour, minute] = time.split(':').map(Number)
  return (
    <LocalTime
      options={{ hour: 'numeric', minute: '2-digit' }}
      value={new Date(Date.UTC(2000, 0, 1, hour, minute))}
      zone="UTC"
    />
  )
}

/** The props a queue row needs beyond its item, all supplied by the list. */
type QueueRowProps = {
  /** A post is being dragged that this row could exchange times with. */
  accepts: boolean
  dragging: boolean
  onDragEnd: () => void
  onDragStart: () => void
  onDrop: (fromId: string) => void
  /** Missing when this row cannot be acted on in bulk. */
  onToggle?: (id: string, on: boolean) => void
  selected: boolean
  warned: boolean
}

/**
 * A stretch of the queue, with the posts written as one run gathered under
 * the run's name. A run can be collapsed to a line, and selected whole, which
 * is what moving or cancelling "those seven posts" needs.
 */
function QueueRows({
  collapsed,
  day,
  free = [],
  items,
  onCollapse,
  onNew,
  onPick,
  rowProps,
  runs,
  zone,
}: {
  /** Runs collapsed to a line, held by the queue so a run reads the same on every day. */
  collapsed: string[]
  /** The day this stretch covers, when it is one day with free slots. */
  day?: string
  /** Free weekly slots on `day`, as "HH:MM" in the brand's zone. */
  free?: string[]
  items: WriteLibrary['queue'][number][]
  onCollapse: (name: string, shut: boolean) => void
  onNew?: (clock: string) => void
  onPick: React.Dispatch<React.SetStateAction<string[]>>
  rowProps: (item: WriteLibrary['queue'][number]) => QueueRowProps
  /** The runs the whole queue holds, so one spread over two days stays one run. */
  runs: Map<string, QueueRow[]>
  zone: string
}) {
  const byId = new Map(items.map((item) => [item.id, item]))
  // Runs and free slots share one timeline, so an empty slot still reads as a
  // gap in the day rather than a list appended under it. Sorted by the whole
  // wall time, because "Needs a look" and "Later" span days.
  const entries = [
    ...queueGroups(items, runs).map((group) => ({
      group,
      slot: null,
      when: wallTime(new Date(group.rows[0].at), zone).slice(0, 16),
    })),
    ...free.map((clock) => ({ group: null, slot: clock, when: `${day ?? ''}T${clock}` })),
  ].sort((a, b) => a.when.localeCompare(b.when))
  return (
    <ul>
      {entries.map(({ group, slot }) => {
        if (!group)
          return (
            <li
              className="m-2 flex items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-[11px] text-muted-foreground"
              data-testid="queue-free-slot"
              key={`free-${slot}`}
            >
              <span>
                <ClockLabel time={slot as string} /> · free
              </span>
              {onNew ? (
                <Button
                  className="h-6 px-2 text-[11px]"
                  onClick={() => onNew(slot as string)}
                  size={null}
                  variant="ghost"
                >
                  + New
                </Button>
              ) : null}
            </li>
          )
        const rows = group.rows.flatMap((row) => byId.get(row.id) ?? [])
        if (!group.name)
          return rows.map((item) => <QueueItem item={item} key={item.id} {...rowProps(item)} />)
        const shut = collapsed.includes(group.name)
        const name = group.name
        // The whole run, which can reach beyond this day: its header counts and
        // spans all of it, and "Select the run" picks all of it.
        const whole = runs.get(group.name) ?? rows
        const span = `${wallTime(new Date(whole[0].at), zone).slice(11, 16)}–${wallTime(
          new Date(whole[whole.length - 1].at),
          zone
        ).slice(11, 16)}`
        return (
          <li key={group.name}>
            <div
              className="mx-2 mt-2 flex items-center gap-2 rounded-lg bg-foreground/[0.03] px-2 py-1 text-[11px]"
              data-testid="queue-group"
            >
              <Button
                aria-expanded={!shut}
                className="h-6 min-w-0 flex-1 justify-start gap-1 px-1 text-[11px] font-medium"
                onClick={() => onCollapse(name, !shut)}
                size={null}
                variant="ghost"
              >
                <CaretDownIcon
                  aria-hidden
                  className={cn('size-3 transition-transform', shut && '-rotate-90')}
                />
                <span className="truncate">{group.name}</span>
                <span className="text-muted-foreground">
                  · {whole.length} posts · {span}
                  {whole.length > rows.length ? ` · ${rows.length} here` : ''}
                </span>
              </Button>
              <Button
                className="h-6 px-2 text-[11px]"
                onClick={() =>
                  onPick((current) => [
                    ...new Set([
                      ...current,
                      ...whole.filter((row) => row.kind === 'scheduled').map((row) => row.id),
                    ]),
                  ])
                }
                size={null}
                variant="ghost"
              >
                Select the run
              </Button>
            </div>
            {shut ? null : (
              <ul>
                {rows.map((item) => (
                  <QueueItem item={item} key={item.id} {...rowProps(item)} />
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * One queued post or planned draft. It opens its draft, can be selected for a
 * bulk change, expands in place to its whole text, length and destination
 * (so checking a queue is not a round trip per post), and can be dragged onto
 * another queued post to exchange their times.
 */
function QueueItem({
  accepts = false,
  dragging = false,
  item,
  onDragEnd,
  onDragStart,
  onDrop,
  onToggle,
  selected = false,
  warned = false,
}: { item: WriteLibrary['queue'][number] } & Partial<QueueRowProps>) {
  const { data } = useWrite()
  const [open, setOpen] = React.useState(false)
  const [over, setOver] = React.useState(false)
  const account = data.activeSet?.accounts.find((entry) => item.accountIds.includes(entry.id))
  const channel = channelForPlatform(item.platform ?? '')
  // A queued post carries the text it will publish, so its length is the real
  // one. A planned draft carries only an opening, so counting it would be a
  // number about nothing: expanding one shows what there is and says so.
  const counted = item.kind === 'scheduled' && channel
  const length = counted ? platformCaptionLength(channel, item.caption) : 0
  const limit = counted ? CAPABILITIES[channel].captionLimit : null
  return (
    <li
      className={cn(
        'm-2 rounded-lg border',
        item.kind === 'planned' ? 'border-dashed border-violet-400/40' : 'border-border',
        selected && 'border-sky-400/60 bg-sky-400/[0.06]',
        warned && !selected && 'border-amber-400/50',
        over && 'border-sky-500',
        dragging && 'opacity-50'
      )}
      draggable={item.kind === 'scheduled' && Boolean(onDrop)}
      onDragEnd={() => {
        setOver(false)
        onDragEnd?.()
      }}
      onDragOver={(event) => {
        // Only our own drag, only onto a post it can be exchanged with, and
        // only once: dragover fires continuously.
        if (!accepts || !event.dataTransfer.types.includes(QUEUE_DRAG)) return
        event.preventDefault()
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDragStart={(event) => {
        event.dataTransfer.setData(QUEUE_DRAG, item.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart?.()
      }}
      onDrop={(event) => {
        setOver(false)
        if (!accepts) return
        const from = event.dataTransfer.getData(QUEUE_DRAG)
        if (from) onDrop?.(from)
      }}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        {onToggle ? (
          <Checkbox
            aria-label={`Select “${item.caption.slice(0, 60) || 'this post'}”`}
            checked={selected}
            className="mt-0.5"
            onCheckedChange={(checked) => onToggle(item.id, checked === true)}
          />
        ) : null}
        {/* The row carries the drag, so its link must not start one of its own. */}
        <Link
          className="min-w-0 flex-1 rounded-md hover:bg-foreground/[0.02]"
          data-testid={item.kind === 'planned' ? 'queue-planned' : 'queue-item'}
          draggable={false}
          href={draftHref(item.draftId, data.activeSet?.id)}
        >
          <p
            className={cn(
              'flex flex-wrap items-center gap-1.5 text-[11px]',
              item.kind === 'planned'
                ? 'text-violet-700 dark:text-violet-300'
                : 'text-sky-700 dark:text-sky-300'
            )}
          >
            <LocalTime
              options={{
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                month: 'short',
                timeZone: data.activeSet?.timeZone,
                timeZoneName: 'short',
                weekday: 'short',
              }}
              value={item.at}
            />
            · {item.kind === 'planned' ? 'planned, not scheduled' : platformLabel(item.platform)}
            {account ? (
              <span className="text-muted-foreground">
                · {account.handle ? `@${account.handle}` : account.displayName}
              </span>
            ) : null}
            {item.state && item.state !== 'Scheduled' ? (
              <span className="text-amber-700 dark:text-amber-300">· {item.state}</span>
            ) : null}
          </p>
          <p
            className={cn(
              'mt-0.5 text-[13px] leading-snug text-foreground',
              open ? 'whitespace-pre-wrap' : 'line-clamp-2'
            )}
          >
            {item.caption}
          </p>
        </Link>
        <Button
          aria-expanded={open}
          aria-label={open ? 'Show less of this post' : 'Show the whole post'}
          className="size-6 shrink-0"
          onClick={() => setOpen((current) => !current)}
          size={null}
          variant="ghost"
        >
          <CaretDownIcon aria-hidden className={cn('size-3', open && 'rotate-180')} />
        </Button>
      </div>
      {open ? (
        <p className="px-2 pb-2 text-[11px] text-muted-foreground">
          {counted ? (
            <span className="tabular-nums">
              {length}
              {limit ? ` / ${limit}` : ''} characters
              {limit && length > limit ? ' · over the limit' : ''}
            </span>
          ) : (
            'The draft’s opening. Open it to read and count the whole post.'
          )}
        </p>
      ) : null}
    </li>
  )
}

'use client'

import * as React from 'react'
import Link from 'next/link'
import { domToPng } from 'modern-screenshot'
import { DAY_STYLE, LocalTime, useWhen } from '@/components/drafts/local-time'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AnalyzeNav, WorkspaceNav } from '@/components/plan/WorkspaceNav'
import {
  analyticsSettingsSchema,
  type AnalyticsQuery,
  type AnalyticsReport,
} from '@/lib/api/contracts/plan-analyze'
import { call } from '@/lib/content-drafts/client'
import { type SocialSetWire } from '@/lib/write/client'
import {
  brandValue,
  readAnalyticsReport,
  chartCSV,
  chartPoints,
  fetchAnalyticsReport,
  formatValue,
  initialQuery,
  initialSelection,
  METRICS,
  noStats,
  postsCSV,
  PRESETS,
  presetRange,
  queryString,
  SORTS,
  STATES,
  STATS_PENDING,
  statsPending,
} from '@/lib/analyze/report'
import { platformLabel } from '@/lib/content-drafts/serialize'
import { downloadBlob } from '@/lib/export/export-design'
import { isTimeZone } from '@/lib/write/zoned-time'
import { ChartBoundary, MetricChart } from './MetricChart'
import { BrandSummary } from './BrandSummary'
import { Hourly } from './Hourly'
import { ChartShare } from './ChartShare'
import { InfoTip } from './InfoTip'

type Row = AnalyticsReport['posts'][number]

/** All views derive from one account/query key; stale responses never cross that boundary. */
export function AnalyzeWorkspace({
  sets = [],
  canManage = false,
  initial = {},
  publicToken,
}: {
  sets?: SocialSetWire[]
  canManage?: boolean
  initial?: Record<string, string | undefined>
  publicToken?: string
}) {
  const accounts = sets.flatMap((set) =>
    set.accounts.map((account) => ({ ...account, setName: set.name, timeZone: set.timeZone }))
  )
  const [accountId, setAccountId] = React.useState(() => initialSelection(sets, initial))
  const selectedAccount = accounts.find((a) => a.id === accountId)
  const brand = sets.find((set) => brandValue(set.id) === accountId)
  const brandId = brand?.id
  const [query, setQuery] = React.useState<AnalyticsQuery>(() =>
    initialQuery(initial, selectedAccount?.timeZone ?? brand?.timeZone ?? 'UTC')
  )
  const [preset, setPreset] = React.useState(initial.from ? 'Custom' : '1 month')
  const [metric, setMetric] = React.useState(
    initial.metric && METRICS[initial.metric] ? initial.metric : ''
  )
  const [growth, setGrowth] = React.useState(false)
  const [refresh, setRefresh] = React.useState(0)
  const [loaded, setLoaded] = React.useState<{ key: string; report: AnalyticsReport } | null>(null)
  const [error, setError] = React.useState('')
  const [formError, setFormError] = React.useState('')
  const [working, setWorking] = React.useState(false)
  const [cursorStack, setCursorStack] = React.useState<string[]>([])
  const [row, setRow] = React.useState<Row | null>(null)
  const [goalOpen, setGoalOpen] = React.useState(false)
  const [sharing, setSharing] = React.useState(false)
  const [image, setImage] = React.useState<string | null>(null)
  const chart = React.useRef<HTMLDivElement>(null)
  const when = useWhen()
  // Report ranges are calendar days, not moments: read them in UTC so the day stays the one named.
  const day = (key: string) => when(key, 'UTC', DAY_STYLE)
  const endpoint = publicToken
    ? `/api/analytics/public/${encodeURIComponent(publicToken)}`
    : `/api/v1/analytics/${encodeURIComponent(accountId)}`
  const key = `${endpoint}?${queryString(query)}`
  const report = loaded?.key === key ? loaded.report : null
  const cards = Object.entries(METRICS).filter(
    ([id]) => !report || !noStats(report) || id === 'publishedPosts'
  )
  const update = (patch: Partial<AnalyticsQuery>) => {
    setQuery((q) => ({ ...q, ...patch, cursor: '', asOf: undefined }))
    setCursorStack([])
    setRow(null)
  }
  React.useEffect(() => {
    if ((!publicToken && !accountId) || brandId) return
    const controller = new AbortController()
    setError('')
    setLoaded((current) => (current?.key === key ? current : null))
    fetchAnalyticsReport(key, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLoaded({ key, report: data })
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
    return () => controller.abort()
  }, [key, refresh, accountId, brandId, publicToken])
  React.useEffect(() => {
    const params = new URLSearchParams(queryString({ ...query, cursor: '', asOf: undefined }))
    if (brandId) params.set('set', brandId)
    else if (!publicToken) params.set('account', accountId)
    if (metric) params.set('metric', metric)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [query, accountId, brandId, metric, publicToken])
  const action = async (fn: () => Promise<void>) => {
    setWorking(true)
    setFormError('')
    try {
      await fn()
    } catch (e) {
      setFormError((e as Error).message)
    } finally {
      setWorking(false)
    }
  }
  const refreshOne = async (id: string) => {
    const result = await call<{ refreshed: boolean }>(
      `/api/v1/analytics/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' }
    )
    if (!result.refreshed) throw new Error('Stats were just updated. Try again in a minute.')
  }
  // Who may ask the networks asks them first; everyone gets the newest stored stats.
  const refreshStats = () =>
    action(async () => {
      try {
        if (!canManage || publicToken) return
        const ids = brand ? brand.accounts.map((a) => a.id) : [accountId]
        const failed = (await Promise.allSettled(ids.map(refreshOne))).find(
          (result) => result.status === 'rejected'
        )
        if (failed) throw failed.reason
      } finally {
        setRefresh((n) => n + 1)
      }
    })
  const select = (value: string) => {
    setAccountId(value)
    update({})
    setGoalOpen(false)
    setSharing(false)
    setImage(null)
    setInspection(null)
  }
  const saveSettings = async (input: {
    action: 'goal' | 'enable' | 'revoke'
    goal?: AnalyticsReport['settings']['goal']
  }) => {
    if (!report) throw new Error('Load analytics before changing settings.')
    const settings = analyticsSettingsSchema.parse(
      await call(`${endpoint}/settings`, {
        method: 'PUT',
        body: { ...input, version: report.settings.version },
      })
    )
    setLoaded({ key, report: { ...report, settings } })
    setRefresh((n) => n + 1)
  }
  const fullRows = async () => {
    if (!report) return []
    const rows: Row[] = [],
      snapshot = { ...query, asOf: report.asOf, cursor: '', limit: 500 }
    const seen = new Set<string>()
    let hasMore = true
    while (hasMore) {
      const page = readAnalyticsReport(await call(`${endpoint}?${queryString(snapshot)}`))
      rows.push(...page.posts)
      if (!page.nextCursor) break
      if (seen.has(page.nextCursor))
        throw new Error('Pagination did not advance. Reload and retry.')
      seen.add(page.nextCursor)
      snapshot.cursor = page.nextCursor
      hasMore = Boolean(page.nextCursor)
    }
    return rows
  }
  const exportPosts = () =>
    action(async () => {
      if (!report) return
      const rows = await fullRows()
      downloadBlob(
        new Blob([postsCSV(report, rows)], { type: 'text/csv;charset=utf-8' }),
        `shots-${report.platform}-posts-${query.from}-${query.to}.csv`
      )
    })
  const inspectHourly = (ids: string[], label: string) =>
    void action(async () => {
      const all = await fullRows()
      setInspection({ label, rows: all.filter((p) => ids.includes(p.id)) })
    })
  const [inspection, setInspection] = React.useState<{ label: string; rows: Row[] } | null>(null)
  const shareImage = () =>
    action(async () => {
      if (chart.current)
        setImage(
          await domToPng(chart.current, {
            backgroundColor: '#ffffff',
            scale: 2,
            filter: (node) => !(node instanceof HTMLElement && node.dataset.slot === 'disclosure'),
          })
        )
    })
  if (!publicToken && !accounts.length)
    return (
      <div>
        <WorkspaceNav active="analyze" />
        <AnalyzeNav active="Overview" />
        <main className="mx-auto max-w-7xl space-y-2 p-4 sm:p-6">
          <h1 className="text-2xl font-semibold">Analyze</h1>
          <p className="text-sm text-muted-foreground">
            Connect a social account to collect analytics.
          </p>
          <Button asChild variant="outline">
            <Link href="/settings/publishing-brands">Connect a social account</Link>
          </Button>
        </main>
      </div>
    )
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {!publicToken ? (
        <>
          <WorkspaceNav active="analyze" />
          <AnalyzeNav active="Overview" />
        </>
      ) : (
        <header className="border-b px-6 py-4 font-semibold">Shots · Shared analytics</header>
      )}
      <main className="mx-auto max-w-7xl space-y-5 p-4 sm:p-6">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-2xl font-semibold">Analyze</h1>
          {!publicToken ? (
            <Label className="grid gap-1.5">
              Account{' '}
              <Combobox
                aria-label="Analytics account"
                className="w-72"
                onValueChange={select}
                options={[
                  ...sets
                    .filter((set) => set.accounts.length > 1)
                    .map((set) => ({
                      label: `${set.name} · All accounts`,
                      value: brandValue(set.id),
                    })),
                  ...accounts.map((a) => ({
                    label: `${a.setName} · ${platformLabel(a.platform)} · ${a.handle ?? a.displayName ?? a.id}`,
                    value: a.id,
                  })),
                ]}
                searchPlaceholder="Search accounts"
                value={accountId}
              />
            </Label>
          ) : null}
          {report?.profileUrl ? (
            <Button asChild className="h-auto p-0" size={null} variant="link">
              <a href={report.profileUrl} target="_blank" rel="noreferrer">
                View {report.name} on {platformLabel(report.platform)}
              </a>
            </Button>
          ) : null}
          {report ? (
            <span className="text-xs text-muted-foreground">
              {report.checkedAt
                ? `Updated ${when(report.checkedAt, query.timeZone)}`
                : 'Not updated yet'}
            </span>
          ) : null}
          <Button variant="outline" disabled={working} onClick={() => void refreshStats()}>
            Refresh
          </Button>
          {canManage && !publicToken && !brand ? (
            <Button variant="outline" disabled={!report} onClick={() => setSharing(true)}>
              Public sharing
            </Button>
          ) : null}
        </header>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
          <Label className="grid gap-1.5">
            Period
            <DateRangePicker
              aria-label="Date range"
              onChange={(range) => {
                setPreset('Custom')
                update(range)
              }}
              onPreset={(label) => {
                setPreset(label)
                update(presetRange(label, query.timeZone))
              }}
              preset={preset}
              presets={PRESETS.filter((label) => label !== 'Custom')}
              value={{ from: query.from, to: query.to }}
            />
          </Label>
          <TimeZonePicker
            className="w-56"
            label="Timezone"
            onChange={(timeZone) => update({ timeZone })}
            value={query.timeZone}
          />
          <Label className={brand ? 'hidden' : 'grid gap-1.5'}>
            Grouping
            <Select
              value={query.grouping}
              onValueChange={(value) => update({ grouping: value as AnalyticsQuery['grouping'] })}
            >
              <SelectTrigger aria-label="Grouping">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
              </SelectContent>
            </Select>
          </Label>
        </div>
        {formError ? <p role="alert">{formError}</p> : null}
        {brand ? (
          <BrandSummary accounts={brand.accounts} onOpen={select} query={query} refresh={refresh} />
        ) : error ? (
          <div role="alert" className="rounded border p-6">
            {error} <Button onClick={() => setRefresh((n) => n + 1)}>Retry analytics</Button>
          </div>
        ) : !report ? (
          <div>
            <p role="status">Loading analytics…</p>
            <div aria-hidden="true" className="grid grid-cols-2 gap-4">
              {Array.from({ length: 6 }, (_, i) => (
                <div className="h-32 animate-pulse rounded-xl bg-muted" key={i} />
              ))}
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {report.name} · {platformLabel(report.platform)} · {day(query.from)} – {day(query.to)} (
              {query.timeZone}) · {STATES[report.status]}.{' '}
              {report.coverageStart
                ? `Stats start ${when(report.coverageStart, query.timeZone, DAY_STYLE)}.`
                : null}
            </p>
            {report.status === 'unsupported' || report.status === 'forbidden' ? (
              <aside role="status" className="rounded-lg border p-4">
                <h2 className="font-semibold">
                  {report.status === 'unsupported'
                    ? 'Stats aren’t available for this account'
                    : 'Reconnect this account to see stats'}
                </h2>
                <p>
                  {report.status === 'unsupported'
                    ? 'This network doesn’t share stats with Shots. Your published posts are still listed below.'
                    : 'Reconnect it and allow access to analytics. The stats collected so far are kept.'}
                </p>
              </aside>
            ) : null}
            {metric ? (
              <section className="rounded-xl border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="ghost" onClick={() => setMetric('')}>
                    ← Overview
                  </Button>
                  <h2 className="mr-auto text-lg font-semibold">{METRICS[metric]}</h2>
                  {metric === 'followers' ? (
                    <Label>
                      <Checkbox
                        checked={growth}
                        onCheckedChange={(checked) => setGrowth(checked === true)}
                      />
                      Interval growth
                    </Label>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={
                      !chartPoints(report.metrics[metric], growth && metric === 'followers').some(
                        (p) => p.value !== null
                      )
                    }
                    onClick={() =>
                      downloadBlob(
                        new Blob([chartCSV(report, metric, growth && metric === 'followers')], {
                          type: 'text/csv;charset=utf-8',
                        }),
                        `shots-${metric}-${query.from}-${query.to}.csv`
                      )
                    }
                  >
                    Export chart CSV
                  </Button>
                  <Button
                    disabled={
                      working ||
                      !chartPoints(report.metrics[metric], growth && metric === 'followers').some(
                        (p) => p.value !== null
                      )
                    }
                    onClick={() => void shareImage()}
                  >
                    Share chart image
                  </Button>
                </div>
                {report.metrics[metric] ? (
                  <>
                    <div ref={chart} className="mt-4 bg-white p-5 text-slate-900">
                      <h3 className="text-xl font-semibold">
                        {report.name} · {METRICS[metric]}
                        {growth && metric === 'followers' ? ' interval growth' : ''}
                      </h3>
                      <p className="text-sm">
                        {platformLabel(report.platform)} · {day(query.from)} – {day(query.to)} · {query.timeZone} ·{' '}
                        {query.grouping}
                      </p>
                      <p className="my-3 text-3xl">
                        {formatValue(
                          growth && metric === 'followers'
                            ? chartPoints(report.metrics[metric], true).at(-1)?.value
                            : report.metrics[metric].value
                        )}
                      </p>
                      <ChartBoundary key={`${key}:${metric}`}>
                        <MetricChart
                          metric={report.metrics[metric]}
                          growth={growth && metric === 'followers'}
                        />
                      </ChartBoundary>
                      <p className="text-xs">Stats through {when(report.asOf, query.timeZone)}.</p>
                    </div>
                    <Disclosure className="mt-4">
                      <DisclosureTrigger>About {METRICS[metric]}</DisclosureTrigger>
                      <DisclosureContent>
                      <p>{report.metrics[metric].definition}</p>
                      <p>
                        Change compares the preceding equal number of calendar days. A zero or
                        missing baseline has no percentage comparison.{' '}
                        {report.metrics[metric].missing} posts lack this metric.
                      </p>
                      </DisclosureContent>
                    </Disclosure>
                  </>
                ) : (
                  <p role="status">
                    This metric is unavailable.{' '}
                    <Button onClick={() => setRefresh((n) => n + 1)} size="sm" variant="link">
                      Retry
                    </Button>
                  </p>
                )}
              </section>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {cards.map(([id, name]) => {
                  const m = report.metrics[id]
                  return (
                    <section key={id} className="relative rounded-xl border p-4">
                      <Button
                        className="h-auto w-full flex-col items-start gap-0 p-0 text-left font-normal whitespace-normal"
                        onClick={() => setMetric(id)}
                        size={null}
                        variant="ghost"
                      >
                        <h2 className="font-medium">{name}</h2>
                        <p
                          className="my-3 text-3xl"
                          aria-label={`${name}: ${formatValue(m?.value)}`}
                          title={formatValue(m?.value)}
                        >
                          {formatValue(m?.value, true)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {STATES[m?.status ?? 'insufficient']}
                          {m?.change != null
                            ? ` · ${formatValue(m.change)}% vs the previous period`
                            : ''}
                        </p>
                      </Button>
                      <InfoTip className="absolute top-2 right-2" label={`About ${name}`}>
                        <p>{m?.definition ?? 'No definition available.'}</p>
                        <p className="mt-2 text-muted-foreground">
                          {m?.samples ?? 0} observations · {m?.missing ?? 0} missing
                        </p>
                      </InfoTip>
                      {m?.status === 'failed' ? (
                        <Button
                          className="mt-2 h-auto p-0 text-xs"
                          onClick={() => setRefresh((n) => n + 1)}
                          size={null}
                          variant="link"
                        >
                          Retry metric
                        </Button>
                      ) : null}
                    </section>
                  )
                })}
                {statsPending(report) ? (
                  <p
                    role="status"
                    className="flex items-center rounded-xl border border-dashed p-4 text-sm text-muted-foreground lg:col-span-2"
                  >
                    {STATS_PENDING}
                  </p>
                ) : null}
                {!publicToken && (report.totalPosts > 0 || report.settings.goal) ? (
                  <section className="relative rounded-xl border p-4">
                    <h2 className="font-medium">Posting Streak</h2>
                    <InfoTip className="absolute top-2 right-2" label="About Posting Streak">
                      Original posts that went live count. Replies and later posts in a thread
                      don’t. Posting regularly doesn’t guarantee more followers.
                    </InfoTip>
                    {report.settings.goal ? (
                      <>
                        <p className="my-3 text-3xl">
                          {report.progress.streak}{' '}
                          {report.settings.goal.cadence === 'daily' ? 'days' : 'weeks'}
                        </p>
                        <p className="text-sm">
                          {report.progress.current} posts this period · goal{' '}
                          {report.progress.required}. {report.settings.goal.timeZone}
                        </p>
                      </>
                    ) : (
                      <p className="my-3 text-sm">Set a goal to track how often you post.</p>
                    )}
                    <Button
                      variant="outline"
                      disabled={!canManage}
                      onClick={() => setGoalOpen(true)}
                    >
                      {report.settings.goal ? 'Edit goal' : 'Set posting goal'}
                    </Button>
                  </section>
                ) : null}
              </div>
            )}
            {!publicToken ? (
              <ChartBoundary key={`hourly:${key}`}>
                <Hourly report={report} onInspect={inspectHourly} />
              </ChartBoundary>
            ) : null}
            <section className="rounded-xl border p-4">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <h2 className="mr-auto font-semibold">Post performance · {report.totalPosts}</h2>
                <Label className="grid gap-1.5">
                  Scope
                  <Select
                    value={query.scope}
                    onValueChange={(value) => update({ scope: value as AnalyticsQuery['scope'] })}
                  >
                    <SelectTrigger aria-label="Post scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="replies">Replies</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="grid gap-1.5">
                  Sort
                  <Select
                    value={query.sort}
                    onValueChange={(value) => update({ sort: value as AnalyticsQuery['sort'] })}
                  >
                    <SelectTrigger aria-label="Sort posts">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(SORTS).map(([id, label]) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="grid gap-1.5">
                  Order
                  <Select
                    value={query.direction}
                    onValueChange={(value) => update({ direction: value as 'asc' | 'desc' })}
                  >
                    <SelectTrigger aria-label="Sort direction">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">Descending</SelectItem>
                      <SelectItem value="asc">Ascending</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Button
                  variant="outline"
                  disabled={working || report.totalPosts === 0}
                  onClick={() => void exportPosts()}
                >
                  Export posts CSV
                </Button>
              </div>
              {!report.posts.length ? (
                <p>No confirmed posts in this scope. Try another date range.</p>
              ) : (
                <PostTable
                  rows={report.posts}
                  zone={query.timeZone}
                  sort={query.sort}
                  direction={query.direction}
                  onSort={(sort) =>
                    update({
                      sort,
                      direction: query.sort === sort && query.direction === 'desc' ? 'asc' : 'desc',
                    })
                  }
                  onInspect={setRow}
                />
              )}
              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  disabled={!cursorStack.length}
                  onClick={() => {
                    const stack = cursorStack.slice()
                    const cursor = stack.pop()!
                    setCursorStack(stack)
                    setQuery((q) => ({ ...q, cursor, asOf: report.asOf }))
                  }}
                >
                  Previous page
                </Button>
                <Button
                  variant="outline"
                  disabled={!report.nextCursor}
                  onClick={() => {
                    setCursorStack((s) => [...s, query.cursor])
                    setQuery((q) => ({ ...q, cursor: report.nextCursor!, asOf: report.asOf }))
                  }}
                >
                  Next page
                </Button>
              </div>
            </section>
            {noStats(report) ? null : (
              <Disclosure className="text-sm">
                <DisclosureTrigger>How these numbers work</DisclosureTrigger>
                <DisclosureContent>
                  <p>
                    Engagements sum only returned likes, replies, reposts, profile clicks, and link
                    clicks. Components vary by provider. Engagement rate divides those engagements
                    by positive impressions; it is unavailable when impressions are absent or zero.
                    Post counters are latest observed lifetime values, may be revised by the
                    provider, and are never assumed to include other thread posts. Follower history
                    starts with actual observations. No missing interval is backfilled.
                  </p>
                </DisclosureContent>
              </Disclosure>
            )}
          </>
        )}
        {row ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setRow(null)
            }}
          >
            <DialogContent className="max-h-[85vh] overflow-auto">
              <DialogHeader>
                <DialogTitle>Post statistics</DialogTitle>
                <DialogDescription>
                  {row.remoteId} · {when(row.publishedAt, query.timeZone)}
                </DialogDescription>
              </DialogHeader>
              <p className="whitespace-pre-wrap">{row.excerpt}</p>
              {row.url ? (
                <Button asChild className="h-auto justify-start p-0" size={null} variant="link">
                  <a href={row.url} target="_blank" rel="noreferrer">
                    View this post
                  </a>
                </Button>
              ) : null}
              <dl className="grid grid-cols-2 gap-2">
                {Object.entries(SORTS)
                  .filter(([k]) => k !== 'latest')
                  .map(([k, label]) => (
                    <React.Fragment key={k}>
                      <dt>{label}</dt>
                      <dd>
                        {k === 'engagementRate' && row.metrics[k] !== undefined
                          ? `${formatValue(row.metrics[k] * 100)}%`
                          : formatValue(row.metrics[k])}
                      </dd>
                    </React.Fragment>
                  ))}
              </dl>
              <p className="text-xs">
                {row.observedAt
                  ? `Stats from ${when(row.observedAt, query.timeZone)}.`
                  : 'No stats yet.'}{' '}
                These numbers are for this post only.
              </p>
            </DialogContent>
          </Dialog>
        ) : null}
        {inspection ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setInspection(null)
            }}
          >
            <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
              <DialogHeader>
                <DialogTitle>{inspection.label}</DialogTitle>
                <DialogDescription>
                  Posts published in this hour, {day(query.from)} – {day(query.to)}.
                </DialogDescription>
              </DialogHeader>
              <PostTable
                rows={inspection.rows}
                zone={query.timeZone}
                onInspect={(r) => {
                  setInspection(null)
                  setRow(r)
                }}
              />
            </DialogContent>
          </Dialog>
        ) : null}
        {goalOpen && report ? (
          <GoalDialog
            report={report}
            onClose={() => setGoalOpen(false)}
            onSave={async (goal) => {
              await saveSettings({ action: 'goal', goal })
              setGoalOpen(false)
            }}
          />
        ) : null}
        {sharing && report ? (
          <Dialog open onOpenChange={setSharing}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Public analytics</DialogTitle>
                <DialogDescription>
                  Explicitly share this account’s historical analytics and published post excerpts.
                  Sharing remains private until enabled.
                </DialogDescription>
              </DialogHeader>
              {report.settings.publicToken ? (
                <>
                  <Label className="grid gap-1.5">
                    Public link
                    <Input
                      className="w-full"
                      readOnly
                      value={`${window.location.origin}/analytics/public/${report.settings.publicToken}`}
                    />
                  </Label>
                  <Button asChild className="h-auto justify-start p-0" size={null} variant="link">
                    <a
                      href={`/analytics/public/${report.settings.publicToken}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open public page
                    </a>
                  </Button>
                  <Button
                    disabled={working}
                    onClick={() => void action(() => saveSettings({ action: 'revoke' }))}
                  >
                    Revoke public access
                  </Button>
                  <p className="text-xs">
                    Revocation blocks subsequent requests. Previously downloaded files and
                    information already viewed cannot be recalled.
                  </p>
                </>
              ) : (
                <Button
                  disabled={working}
                  onClick={() => void action(() => saveSettings({ action: 'enable' }))}
                >
                  Enable public analytics
                </Button>
              )}
              {formError ? <p role="alert">{formError}</p> : null}
            </DialogContent>
          </Dialog>
        ) : null}
        {image && report ? (
          <ChartShare
            source={image}
            name={`${report.name}-${METRICS[metric]}-${query.from}-${query.to}`}
            onClose={() => setImage(null)}
          />
        ) : null}
      </main>
    </div>
  )
}

function PostTable({
  rows,
  zone,
  onInspect,
  sort,
  direction,
  onSort,
}: {
  rows: Row[]
  zone: string
  onInspect: (row: Row) => void
  sort?: string
  direction?: string
  onSort?: (sort: AnalyticsQuery['sort']) => void
}) {
  const columns = [
    'impressions',
    'likes',
    'replies',
    'reposts',
    'bookmarks',
    'engagementRate',
  ] as const
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-left text-sm">
        <TableCaption className="sr-only">
          Individual provider posts, latest observed counters
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="min-w-56 p-2">
              Post
            </TableHead>
            <TableHead
              scope="col"
              aria-sort={
                sort === 'latest' ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
              }
            >
              <Button onClick={() => onSort?.('latest')} size="sm" variant="ghost">
                Published
              </Button>
            </TableHead>
            {columns.map((k) => (
              <TableHead
                scope="col"
                key={k}
                className="p-2"
                aria-sort={sort === k ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                <Button onClick={() => onSort?.(k)} size="sm" variant="ghost">
                  {SORTS[k]}
                </Button>
              </TableHead>
            ))}
            <TableHead scope="col">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="max-w-80 p-2">
                <p className="line-clamp-3">{row.excerpt || 'Media post'}</p>
                <small className="text-muted-foreground">
                  {row.threadPosition !== 0
                    ? 'Thread continuation'
                    : row.isReply
                      ? 'Reply'
                      : row.threadRootId
                        ? 'Thread root'
                        : 'Post'}
                  {row.threadRootId ? ` · ${row.threadRootId}` : ''}
                </small>
                {row.status !== 'available' ? (
                  <small className="block text-muted-foreground">
                    {row.status === 'deleted'
                      ? 'Deleted on the network · last stats kept'
                      : (STATES[row.status] ?? 'Metrics unavailable')}
                  </small>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap p-2">
                <LocalTime value={row.publishedAt} zone={zone} />
                <small className="block text-muted-foreground">
                  {relativeTime(row.publishedAt)}
                </small>
              </TableCell>
              {columns.map((k) => (
                <TableCell
                  className="p-2"
                  key={k}
                  title={
                    row.metrics[k] === undefined ? 'Metric unavailable' : String(row.metrics[k])
                  }
                >
                  {k === 'engagementRate' && row.metrics[k] !== undefined
                    ? `${formatValue(row.metrics[k] * 100)}%`
                    : formatValue(row.metrics[k], true)}
                </TableCell>
              ))}
              <TableCell className="p-2">
                <Button
                  className="h-auto p-0"
                  onClick={() => onInspect(row)}
                  size={null}
                  variant="link"
                >
                  Statistics
                </Button>
                {row.url ? (
                  <Button asChild className="ml-2 h-auto p-0" size={null} variant="link">
                    <a href={row.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
function relativeTime(at: string) {
  const hours = Math.round((Date.parse(at) - Date.now()) / 3600000)
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.abs(hours) < 24 ? hours : Math.round(hours / 24),
    Math.abs(hours) < 24 ? 'hour' : 'day'
  )
}

function GoalDialog({
  report,
  onClose,
  onSave,
}: {
  report: AnalyticsReport
  onClose: () => void
  onSave: (goal: NonNullable<AnalyticsReport['settings']['goal']>) => Promise<void>
}) {
  const [cadence, setCadence] = React.useState<'daily' | 'weekly'>(
    report.settings.goal?.cadence ?? 'daily'
  )
  const [excludeWeekends, setExclude] = React.useState(
    report.settings.goal?.excludeWeekends ?? true
  )
  const [zone, setZone] = React.useState(report.settings.goal?.timeZone ?? report.query.timeZone)
  const [error, setError] = React.useState(''),
    [busy, setBusy] = React.useState(false)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Posting goal</DialogTitle>
          <DialogDescription>
            One original post a day or a week. The goal starts the day you save it, so earlier posts
            don’t count. Changing the goal starts a new streak.
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1.5">
          Cadence
          <Select
            value={cadence}
            onValueChange={(value) => setCadence(value as 'daily' | 'weekly')}
          >
            <SelectTrigger aria-label="Goal cadence">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        <Label>
          <Checkbox
            checked={excludeWeekends}
            onCheckedChange={(checked) => setExclude(checked === true)}
          />
          Exclude weekends
        </Label>
        <TimeZonePicker label="Goal timezone" onChange={setZone} value={zone} />
        <p className="text-xs">
          Weeks begin Monday. A day or week still in progress doesn’t break the streak. Only posts
          that went live count.
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <Button
          disabled={busy}
          onClick={() => {
            if (!isTimeZone(zone)) {
              setError('Choose a valid IANA timezone.')
              return
            }
            setBusy(true)
            void onSave({ cadence, excludeWeekends, timeZone: zone, effectiveDate: '' })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false))
          }}
        >
          Save goal
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  )
}

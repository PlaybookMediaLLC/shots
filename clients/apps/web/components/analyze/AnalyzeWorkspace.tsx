'use client'

import * as React from 'react'
import { flushSync } from 'react-dom'
import Link from 'next/link'
import { domToPng } from 'modern-screenshot'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
  readAnalyticsReport,
  chartCSV,
  chartPoints,
  formatValue,
  initialQuery,
  METRICS,
  postsCSV,
  PRESETS,
  presetRange,
  queryString,
  SORTS,
  STATES,
} from '@/lib/analyze/report'
import { downloadBlob } from '@/lib/export/export-design'
import { isTimeZone } from '@/lib/write/zoned-time'
import { ChartBoundary, MetricChart } from './MetricChart'
import { Hourly } from './Hourly'
import { ChartShare } from './ChartShare'

type Row = AnalyticsReport['posts'][number]

/** All views derive from one account/query key; stale responses never cross that boundary. */
export function AnalyzeWorkspace({
  sets = [],
  campaignsEnabled = false,
  canManage = false,
  initial = {},
  publicToken,
}: {
  sets?: SocialSetWire[]
  /** Campaigns are usable here, so Publish lists Campaign deliveries. */
  campaignsEnabled?: boolean
  canManage?: boolean
  initial?: Record<string, string | undefined>
  publicToken?: string
}) {
  const accounts = sets.flatMap((set) =>
    set.accounts.map((account) => ({ ...account, setName: set.name, timeZone: set.timeZone }))
  )
  const [accountId, setAccountId] = React.useState(
    accounts.find((a) => a.id === initial.account)?.id ?? accounts[0]?.id ?? ''
  )
  const selectedAccount = accounts.find((a) => a.id === accountId)
  const [query, setQuery] = React.useState<AnalyticsQuery>(() =>
    initialQuery(initial, selectedAccount?.timeZone ?? 'UTC')
  )
  const [preset, setPreset] = React.useState(initial.from ? 'Custom' : '1 month')
  const [definitionsOpen, setDefinitionsOpen] = React.useState(false)
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
  const endpoint = publicToken
    ? `/api/analytics/public/${encodeURIComponent(publicToken)}`
    : `/api/v1/analytics/${encodeURIComponent(accountId)}`
  const key = `${endpoint}?${queryString(query)}`
  const report = loaded?.key === key ? loaded.report : null
  const update = (patch: Partial<AnalyticsQuery>) => {
    setQuery((q) => ({ ...q, ...patch, cursor: '', asOf: undefined }))
    setCursorStack([])
    setRow(null)
  }
  React.useEffect(() => {
    if (!publicToken && !accountId) return
    const controller = new AbortController()
    setError('')
    setLoaded((current) => (current?.key === key ? current : null))
    fetch(key, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok)
          throw new Error(
            body.message ??
              (response.status === 404
                ? 'This analytics page is unavailable or sharing has been revoked.'
                : 'Analytics could not load.')
          )
        return readAnalyticsReport(body)
      })
      .then((data) => {
        if (!controller.signal.aborted) setLoaded({ key, report: data })
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message)
      })
    return () => controller.abort()
  }, [key, refresh, accountId, publicToken])
  React.useEffect(() => {
    const params = new URLSearchParams(queryString({ ...query, cursor: '', asOf: undefined }))
    if (!publicToken) params.set('account', accountId)
    if (metric) params.set('metric', metric)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [query, accountId, metric, publicToken])
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
  const refreshProvider = () =>
    action(async () => {
      const result = await call<{ refreshed: boolean }>(`${endpoint}/refresh`, { method: 'POST' })
      if (!result.refreshed)
        setFormError(
          'A refresh is already running or was checked within the last minute. Reload stored data shortly.'
        )
      setRefresh((n) => n + 1)
    })
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
        <WorkspaceNav active="analyze" campaigns={campaignsEnabled} />
        <AnalyzeNav active="Overview" />
        <main className="mx-auto max-w-7xl space-y-2 p-4 sm:p-6">
          <h1 className="text-2xl font-semibold">Analyze</h1>
          <p className="text-sm text-muted-foreground">
            Connect a social account to collect analytics.
          </p>
          <Button asChild variant="outline">
            <Link href="/workspace/social-sets">Connect a social account</Link>
          </Button>
        </main>
      </div>
    )
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {!publicToken ? (
        <>
          <WorkspaceNav active="analyze" campaigns={campaignsEnabled} />
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
              <NativeSelect
                aria-label="Analytics account"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value)
                  update({})
                  setGoalOpen(false)
                  setSharing(false)
                  setImage(null)
                  setInspection(null)
                }}
              >
                {accounts.map((a) => (
                  <NativeSelectOption key={a.id} value={a.id}>
                    {a.setName} · {a.platform} · {a.handle ?? a.displayName ?? a.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          ) : null}
          {report?.profileUrl ? (
            <Button asChild className="h-auto p-0" size={null} variant="link">
              <a href={report.profileUrl} target="_blank" rel="noreferrer">
                View {report.name} on {report.platform}
              </a>
            </Button>
          ) : null}
          {!publicToken ? (
            <Button
              variant="outline"
              disabled={!canManage || working}
              title={
                !canManage
                  ? 'Publishing permission is required to refresh provider data.'
                  : undefined
              }
              onClick={() => void refreshProvider()}
            >
              Refresh from provider
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            Reload
          </Button>
          {canManage && !publicToken ? (
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
          <Label className="grid gap-1.5">
            Grouping
            <NativeSelect
              aria-label="Grouping"
              value={query.grouping}
              onChange={(e) => update({ grouping: e.target.value as AnalyticsQuery['grouping'] })}
            >
              <NativeSelectOption value="daily">Daily</NativeSelectOption>
              <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
              <NativeSelectOption value="monthly">Monthly</NativeSelectOption>
            </NativeSelect>
          </Label>
        </div>
        {formError ? <p role="alert">{formError}</p> : null}
        {error ? (
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
              {report.name} · {report.platform} · {query.from} through {query.to} ({query.timeZone})
              · {STATES[report.status]}.{' '}
              {report.checkedAt
                ? `Checked ${new Date(report.checkedAt).toLocaleString()}.`
                : 'No provider check yet.'}{' '}
              {report.coverageStart
                ? `Observations begin ${new Date(report.coverageStart).toLocaleDateString()}.`
                : 'No historical observations yet.'}
            </p>
            {report.status === 'unsupported' || report.status === 'forbidden' ? (
              <aside role="status" className="rounded-lg border p-4">
                <h2 className="font-semibold">
                  {report.status === 'unsupported'
                    ? 'Provider analytics unavailable'
                    : 'Provider permission required'}
                </h2>
                <p>
                  {report.status === 'unsupported'
                    ? 'The installed adapter does not expose authorized analytics for this account. Known publications remain available below; provider counters are unavailable.'
                    : 'Reconnect this account with analytics permission to resume collection. Existing observations retain their collection dates.'}
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
                        {report.platform} · {query.from} – {query.to} · {query.timeZone} ·{' '}
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
                      <p className="text-xs">
                        Observed through {report.asOf}. {report.metrics[metric].definition}
                      </p>
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
                {Object.entries(METRICS).map(([id, name]) => {
                  const m = report.metrics[id]
                  return (
                    <section key={id} className="rounded-xl border p-4">
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
                            ? ` · ${formatValue(m.change)}% vs previous equal-length period`
                            : ' · No comparable percentage'}
                        </p>
                      </Button>
                      <p className="mt-2 text-xs">
                        {m?.samples ?? 0} observations · {m?.missing ?? 0} missing
                      </p>
                      <Button asChild className="h-auto p-0 text-xs" size={null} variant="link">
                        <a
                          href={`#definition-${id}`}
                          onClick={(event) => {
                            // Open the definitions first, then go to the one asked for.
                            event.preventDefault()
                            flushSync(() => setDefinitionsOpen(true))
                            document.getElementById(`definition-${id}`)?.scrollIntoView()
                          }}
                        >
                          Metric definition
                        </a>
                      </Button>
                      {m?.status === 'failed' ? (
                        <Button
                          className="ml-2 h-auto p-0 text-xs"
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
                {!publicToken ? (
                  <section className="rounded-xl border p-4">
                    <h2 className="font-medium">Posting Streak</h2>
                    {report.settings.goal ? (
                      <>
                        <p className="my-3 text-3xl">
                          {report.progress.streak}{' '}
                          {report.settings.goal.cadence === 'daily' ? 'days' : 'weeks'}
                        </p>
                        <p className="text-sm">
                          {report.progress.current} qualifying posts this period · goal{' '}
                          {report.progress.required}. {report.settings.goal.timeZone}
                        </p>
                      </>
                    ) : (
                      <p className="my-3 text-sm">
                        Set a publishing goal to track confirmed posts.
                      </p>
                    )}
                    <Button
                      variant="outline"
                      disabled={!canManage}
                      onClick={() => setGoalOpen(true)}
                    >
                      {report.settings.goal ? 'Edit goal' : 'Set posting goal'}
                    </Button>
                    <p className="mt-2 text-xs text-muted-foreground">
                      One confirmed root publication qualifies. Replies and thread continuations do
                      not. Consistency does not guarantee audience growth.
                    </p>
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
                  <NativeSelect
                    aria-label="Post scope"
                    value={query.scope}
                    onChange={(e) => update({ scope: e.target.value as AnalyticsQuery['scope'] })}
                  >
                    <NativeSelectOption value="all">All</NativeSelectOption>
                    <NativeSelectOption value="replies">Replies</NativeSelectOption>
                  </NativeSelect>
                </Label>
                <Label className="grid gap-1.5">
                  Sort
                  <NativeSelect
                    aria-label="Sort posts"
                    value={query.sort}
                    onChange={(e) => update({ sort: e.target.value as AnalyticsQuery['sort'] })}
                  >
                    {Object.entries(SORTS).map(([id, label]) => (
                      <NativeSelectOption key={id} value={id}>
                        {label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Label>
                <Label className="grid gap-1.5">
                  Order
                  <NativeSelect
                    aria-label="Sort direction"
                    value={query.direction}
                    onChange={(e) => update({ direction: e.target.value as 'asc' | 'desc' })}
                  >
                    <NativeSelectOption value="desc">Descending</NativeSelectOption>
                    <NativeSelectOption value="asc">Ascending</NativeSelectOption>
                  </NativeSelect>
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
                <p>
                  No confirmed posts in this scope. Choose another range or refresh the connected
                  account. Chart exports remain available when their observations exist.
                </p>
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
            <Disclosure
              className="text-sm"
              onOpenChange={setDefinitionsOpen}
              defaultOpen={definitionsOpen}
            >
              <DisclosureTrigger>Metric definitions and coverage</DisclosureTrigger>
              <DisclosureContent>
              {Object.entries(METRICS).map(([id, title]) => (
                <div key={id} id={`definition-${id}`} className="my-3">
                  <h3 className="font-semibold">{title}</h3>
                  <p>{report.metrics[id]?.definition ?? 'No definition available.'}</p>
                </div>
              ))}
              <p>
                Engagements sum only returned likes, replies, reposts, profile clicks, and link
                clicks. Components vary by provider. Engagement rate divides those engagements by
                positive impressions; it is unavailable when impressions are absent or zero. Post
                counters are latest observed lifetime values, may be revised by the provider, and
                are never assumed to include other thread posts. Follower history starts with actual
                observations. No missing interval is backfilled.
              </p>
              </DisclosureContent>
            </Disclosure>
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
                  {row.remoteId} · {new Date(row.publishedAt).toLocaleString()}
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
                Observed {row.observedAt ?? 'not yet'}. Availability: {row.status}. Each counter
                belongs to this exact provider post.
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
                  Posts published in this hour during {query.from} through {query.to}; lifetime
                  engagement observations.
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
                      ? 'Deleted at provider · last observed metrics retained'
                      : (STATES[row.status] ?? 'Metrics unavailable')}
                  </small>
                ) : null}
              </TableCell>
              <TableCell className="whitespace-nowrap p-2">
                <time dateTime={row.publishedAt} title={row.publishedAt}>
                  {new Date(row.publishedAt).toLocaleString(undefined, {
                    timeZone: zone,
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
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
            One confirmed root post per eligible day or week. Goals begin on the save date; earlier
            history is excluded. Saving a changed goal starts a new streak.
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1.5">
          Cadence
          <NativeSelect
            aria-label="Goal cadence"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
          >
            <NativeSelectOption value="daily">Daily</NativeSelectOption>
            <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
          </NativeSelect>
        </Label>
        <Label>
          <Checkbox
            checked={excludeWeekends}
            onCheckedChange={(checked) => setExclude(checked === true)}
          />
          Exclude weekend publications
        </Label>
        <TimeZonePicker label="Goal timezone" onChange={setZone} value={zone} />
        <p className="text-xs">
          Weeks begin Monday. A period in progress does not break the streak. Failed, scheduled, and
          planned content never qualifies.
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

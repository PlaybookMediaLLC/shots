'use client'

import * as React from 'react'
import { useWhen } from '@/components/drafts/local-time'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AnalyticsQuery, AnalyticsReport } from '@/lib/api/contracts/plan-analyze'
import {
  brandTotal,
  fetchAnalyticsReport,
  formatValue,
  METRICS,
  noStats,
  queryString,
  STATES,
  STATS_PENDING,
  statsPending,
} from '@/lib/analyze/report'
import { platformLabel } from '@/lib/content-drafts/serialize'
import type { SocialSetWire } from '@/lib/write/client'
import { InfoTip } from './InfoTip'

type Account = SocialSetWire['accounts'][number]
type Row = { account: Account } & ({ report: AnalyticsReport } | { error: string })

/**
 * A brand's accounts side by side, read from each account's own report. The
 * reads run in parallel, so the page takes about as long as its slowest account.
 */
export function BrandSummary({
  accounts,
  onOpen,
  query,
  refresh,
}: {
  accounts: Account[]
  onOpen: (accountId: string) => void
  query: AnalyticsQuery
  refresh: number
}) {
  const when = useWhen()
  // Only the report's numbers are read here, so no page of posts comes with them.
  const search = queryString({ ...query, scope: 'all', limit: 1, cursor: '', asOf: undefined })
  const key = `${accounts.map((account) => account.id).join()}?${search}`
  const [loaded, setLoaded] = React.useState<{ key: string; rows: Row[] } | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const read = React.useEffectEvent((signal: AbortSignal) =>
    Promise.all(
      accounts.map(async (account): Promise<Row> => {
        const url = `/api/v1/analytics/${encodeURIComponent(account.id)}?${search}`
        try {
          return { account, report: await fetchAnalyticsReport(url, signal) }
        } catch (e) {
          return { account, error: (e as Error).message }
        }
      })
    )
  )
  React.useEffect(() => {
    const controller = new AbortController()
    void read(controller.signal).then((rows) => {
      if (!controller.signal.aborted) setLoaded({ key, rows })
    })
    return () => controller.abort()
  }, [attempt, key, refresh])
  if (loaded?.key !== key) return <p role="status">Loading analytics…</p>
  const reports = loaded.rows.flatMap((row) => ('report' in row ? [row.report] : []))
  const columns = Object.entries(METRICS).filter(
    ([id]) =>
      id === 'publishedPosts' ||
      reports.some((r) => r.metrics[id]?.value != null || r.metrics[id]?.status === 'failed')
  )
  return (
    <section className="rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-1">
        <h2 className="font-semibold">Accounts in this profile</h2>
        <InfoTip label="About these totals">
          Totals add up each account’s own numbers, and networks count them differently. Followers
          aren’t added up, because one person can follow you on several networks. Open an account
          for its charts and posts.
        </InfoTip>
      </div>
      {reports.every(noStats) && reports.some(statsPending) ? (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {STATS_PENDING}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <Table className="w-full text-left text-sm">
          <TableCaption className="sr-only">Stats for each account, with totals</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Account</TableHead>
              {columns.map(([id, name]) => (
                <TableHead key={id} scope="col">
                  {name}
                </TableHead>
              ))}
              <TableHead scope="col">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableHead scope="row">
                {reports.length < loaded.rows.length ? 'Accounts that loaded' : 'All accounts'}
              </TableHead>
              {columns.map(([id]) => {
                const total = brandTotal(reports, id)
                return (
                  <TableCell className="font-medium" key={id} title={formatValue(total)}>
                    {formatValue(total, true)}
                  </TableCell>
                )
              })}
              <TableCell />
            </TableRow>
            {loaded.rows.map((row) => (
              <TableRow key={row.account.id}>
                <TableHead scope="row">
                  <Button
                    className="h-auto p-0"
                    onClick={() => onOpen(row.account.id)}
                    size={null}
                    variant="link"
                  >
                    {platformLabel(row.account.platform)} ·{' '}
                    {row.account.handle ?? row.account.displayName ?? row.account.id}
                  </Button>
                </TableHead>
                {columns.map(([id]) => {
                  const metric = 'report' in row ? row.report.metrics[id] : undefined
                  return (
                    <TableCell key={id} title={formatValue(metric?.value)}>
                      {metric?.status === 'failed'
                        ? STATES.failed
                        : formatValue(metric?.value, true)}
                    </TableCell>
                  )
                })}
                {'error' in row ||
                row.report.status === 'failed' ||
                Object.values(row.report.metrics).some((metric) => metric?.status === 'failed') ? (
                  <TableCell className="text-xs">
                    <span role="alert">
                      {'error' in row
                        ? row.error
                        : `${platformLabel(row.account.platform)} did not return these numbers.`}
                    </span>{' '}
                    <Button
                      className="h-auto p-0 text-xs"
                      onClick={() => setAttempt((count) => count + 1)}
                      size={null}
                      variant="link"
                    >
                      Retry
                    </Button>
                  </TableCell>
                ) : (
                  <TableCell className="text-xs text-muted-foreground">
                    {row.report.checkedAt && row.report.status === 'available'
                      ? `Updated ${when(row.report.checkedAt, query.timeZone)}`
                      : STATES[row.report.status]}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

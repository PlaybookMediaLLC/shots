'use client'

import { useMemo, useState } from 'react'
import type { SocialObservation, BackendBestTime } from 'screenshot-studio-backend-sdk'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { DateRangePicker } from '@/components/ui/date-range-picker'
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
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AccountMetricCharts } from './account-metric-charts'
import { BestPostingTimes } from './best-posting-times'
import {
  accountObservationBuckets,
  analyticsCSV,
  latestObservations,
  observationBuckets,
} from '@/lib/write/analytics'

/** Stored observations with explicit unavailable states and accessible chart data. */
export function SocialAnalytics({
  observations,
  recommendations = [],
  timeZone = 'UTC',
  canManage = false,
  range,
  rangeError,
  socialSetId,
}: {
  observations: SocialObservation[]
  recommendations?: BackendBestTime[]
  timeZone?: string
  canManage?: boolean
  range: { start: string; end: string }
  rangeError?: string
  socialSetId?: string
}) {
  const [channel, setChannel] = useState('all')
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const [metric, setMetric] = useState('likes')
  const router = useRouter()
  const rows = useMemo(
    () => observations.filter((row) => channel === 'all' || row.platform === channel),
    [observations, channel]
  )
  const latest = latestObservations(rows)
  const posts = latest
    .filter((row) => row.kind === 'post')
    .sort((a, b) => (b.metrics[metric] ?? -1) - (a.metrics[metric] ?? -1))
  const buckets = observationBuckets(rows, period, metric)
  const accountBuckets = accountObservationBuckets(rows, period)
  const maximum = Math.max(1, ...buckets.map((bucket) => bucket.value ?? 0))
  const metrics = [...new Set(['likes', ...rows.flatMap((row) => Object.keys(row.metrics))])]
  const exportCSV = () => {
    const url = URL.createObjectURL(
      new Blob([analyticsCSV(rows)], { type: 'text/csv;charset=utf-8' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = 'social-observations.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section
      className="mx-auto grid w-full max-w-5xl gap-6 overflow-auto p-6"
      data-testid="social-analytics"
    >
      <div>
        <h1 className="text-2xl font-semibold">Social analytics</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Provider observations from {range.start} to {range.end} (UTC). Post metrics are cumulative
          snapshots, not engagement earned during each period. New posts are collected daily for 30
          days.
        </p>
      </div>
      {socialSetId && recommendations.length > 0 && (
        <BestPostingTimes
          items={recommendations}
          setId={socialSetId}
          timeZone={timeZone}
          canManage={canManage}
        />
      )}
      <Label className="grid w-fit gap-1.5">
        Dates
        <DateRangePicker
          aria-label="Analytics dates"
          onChange={({ from, to }) =>
            router.replace(
              `?${new URLSearchParams({ ...(socialSetId ? { set: socialSetId } : {}), from, to })}`
            )
          }
          value={{ from: range.start, to: range.end }}
        />
      </Label>
      {rangeError ? <p role="alert">{rangeError}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <Label className="grid gap-1.5">
          Channel{' '}
          <Select value={channel} onValueChange={(value) => setChannel(value)}>
            <SelectTrigger aria-label="Channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {[...new Set(observations.map((row) => row.platform))].map((platform) => (
                <SelectItem key={platform} value={platform}>{platform}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <Label className="grid gap-1.5">
          Period{' '}
          <Select value={period} onValueChange={(value) => setPeriod(value as 'week' | 'month')}>
            <SelectTrigger aria-label="Period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Weekly</SelectItem>
              <SelectItem value="month">Monthly</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        <Label className="grid gap-1.5">
          Metric{' '}
          <Select value={metric} onValueChange={(value) => setMetric(value)}>
            <SelectTrigger aria-label="Metric">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metrics.map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <Button variant="outline" disabled={!rows.length} onClick={exportCSV}>
          Export CSV
        </Button>
      </div>
      {!rows.length ? (
        <p>
          No provider observations yet. Connect a supported account and wait for the daily
          collection. Unsupported metrics will appear as unavailable.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {['likes', 'impressions', 'replies'].map((name) => {
              const known = posts.filter(
                (row) => row.status === 'available' && row.metrics[name] !== undefined
              )
              return (
                <div className="rounded border p-4" key={name}>
                  <p className="text-sm">Observed {name}</p>
                  <p className="text-2xl">
                    {known.length
                      ? known.reduce((sum, row) => sum + row.metrics[name], 0).toLocaleString()
                      : 'Unavailable'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {known.length} posts with this metric
                  </p>
                </div>
              )
            })}
          </div>
          {buckets.length > 0 && (
            <figure>
              <figcaption className="mb-3">
                Latest cumulative {metric} per post in each {period} (UTC)
              </figcaption>
              <svg
                role="img"
                aria-label={`${metric} snapshots; exact values in the following table`}
                viewBox="0 0 600 180"
                className="h-44 w-full"
              >
                {buckets.map((bucket, index) =>
                  bucket.value === null ? null : (
                    <rect
                      key={bucket.date}
                      fill="currentColor"
                      className="text-sky-700 dark:text-sky-400"
                      x={(index * 600) / buckets.length + 2}
                      y={160 - (bucket.value / maximum) * 150}
                      width={Math.max(1, 600 / buckets.length - 4)}
                      height={Math.max(1, (bucket.value / maximum) * 150)}
                    >
                      <title>{`${bucket.date}: ${bucket.value}`}</title>
                    </rect>
                  )
                )}
              </svg>
              <Table className="w-full text-left text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>Period starts</TableHead>
                    <TableHead>{metric}</TableHead>
                    <TableHead>Reporting posts</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buckets.map((bucket) => (
                    <TableRow key={bucket.date}>
                      <TableCell>{bucket.date}</TableCell>
                      <TableCell>{bucket.value ?? 'Unavailable'}</TableCell>
                      <TableCell>{bucket.posts}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </figure>
          )}
          <div className="overflow-x-auto">
            <h2 className="mb-2 font-medium">Posts by {metric}</h2>
            <Table className="w-full text-left text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead>Post</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>{metric}</TableHead>
                  <TableHead>Observed</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {posts.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-40 truncate py-2">
                      {row.draftId ? (
                        <Button asChild className="h-auto p-0" size={null} variant="link">
                          <Link href={`/publish/${row.draftId}`}>
                            {row.title || row.caption || row.subjectId}
                          </Link>
                        </Button>
                      ) : row.url ? (
                        <Button asChild className="h-auto p-0" size={null} variant="link">
                          <a href={row.url} target="_blank" rel="noopener noreferrer">
                            {row.caption || row.title || row.subjectId}
                          </a>
                        </Button>
                      ) : (
                        row.subjectId
                      )}
                    </TableCell>
                    <TableCell>{row.platform}</TableCell>
                    <TableCell>
                      {row.status === 'available'
                        ? (row.metrics[metric] ?? 'Unavailable')
                        : 'Unavailable'}
                    </TableCell>
                    <TableCell>
                      {new Date(row.observedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC
                    </TableCell>
                    <TableCell>
                      {row.status === 'failed' ? 'Read failed; retry pending' : row.status}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <h2 className="font-medium">Account metrics</h2>
            <p className="text-xs text-muted-foreground">
              Last reported value in each {period}. Provider totals, follower counts and overlapping
              reporting windows are not added together. Definitions differ between channels.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Profile-to-follower conversion is unavailable: these observations do not attribute new
              followers to profile visits. Missing periods are not plotted as zero.
            </p>
            <AccountMetricCharts buckets={accountBuckets} />
            {accountBuckets.length ? (
              <Table className="mt-3 w-full text-left text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>Channel</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Metric</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>As of</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accountBuckets.map((bucket) => (
                    <TableRow key={`${bucket.connection}:${bucket.metric}:${bucket.period}`}>
                      <TableCell>{bucket.platform}</TableCell>
                      <TableCell className="max-w-40 break-words">{bucket.connection}</TableCell>
                      <TableCell>{bucket.metric}</TableCell>
                      <TableCell>{bucket.period}</TableCell>
                      <TableCell>{bucket.date}</TableCell>
                      <TableCell>{bucket.value.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            <Accordion className="mt-3" type="multiple">
              {latest
                .filter((row) => row.kind === 'account' || row.kind === 'feed')
                .map((row) => (
                  <AccordionItem key={row.id} value={row.id}>
                    <AccordionTrigger>
                      {row.platform} · {row.connectionId} ·{' '}
                      {row.kind === 'feed'
                        ? 'Recent provider posts (up to 100 originals, 30 days)'
                        : 'Account metrics'}{' '}
                      · {row.status}
                    </AccordionTrigger>
                    <AccordionContent>
                      {row.series.map((series) => (
                        <div key={series.label}>
                          <h3 className="mt-2 font-medium">
                            {series.label}
                            {series.average ? ' (provider average)' : ''}
                          </h3>
                          <Table className="w-full text-left text-sm">
                            <TableHeader>
                              <TableRow>
                                <TableHead>Date</TableHead>
                                <TableHead>Value</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {series.data.map((point, index) => (
                                <TableRow key={index}>
                                  <TableCell>{point.date}</TableCell>
                                  <TableCell>{point.total}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ))}
                    </AccordionContent>
                  </AccordionItem>
                ))}
            </Accordion>
          </div>
        </>
      )}
    </section>
  )
}

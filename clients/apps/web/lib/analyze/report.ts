import type { AnalyticsQuery, AnalyticsReport } from '@/lib/api/contracts/plan-analyze'
import {
  analyticsMetricSchema,
  analyticsReportSchema,
  analyticsQuerySchema,
} from '@/lib/api/contracts/plan-analyze'
import { addDays, dayOfWeek, zonedDayKey } from '@/lib/settings/zoned-time'
import { isTimeZone } from '@/lib/write/zoned-time'

export const PRESETS = [
  '7 days',
  '14 days',
  '1 month',
  '3 months',
  '6 months',
  '1 year',
  'Current week',
  'Last week',
  'Current month',
  'Last month',
  'Custom',
] as const
export const METRICS: Record<string, string> = {
  followers: 'Followers',
  impressions: 'Impressions',
  publishedPosts: 'Published Posts',
  profileClicks: 'Profile Clicks',
  engagements: 'Engagements',
}
/** A malformed metric fails locally; neighboring validated metrics remain usable. */
export function readAnalyticsReport(value: unknown): AnalyticsReport {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const source =
    raw.metrics && typeof raw.metrics === 'object' ? (raw.metrics as Record<string, unknown>) : {}
  const metrics = Object.fromEntries(
    Object.keys(METRICS).map((key) => {
      const parsed = analyticsMetricSchema.safeParse(source[key])
      return [
        key,
        parsed.success
          ? parsed.data
          : {
              status: source[key] === undefined ? 'insufficient' : 'failed',
              value: null,
              previous: null,
              change: null,
              points: [],
              samples: 0,
              missing: 0,
              definition: 'This metric did not return a usable series. Refresh to retry.',
            },
      ]
    })
  )
  return analyticsReportSchema.parse({ ...raw, metrics })
}

export const SORTS = {
  latest: 'Publication date',
  impressions: 'Impressions',
  likes: 'Likes',
  replies: 'Replies',
  reposts: 'Reposts',
  bookmarks: 'Bookmarks',
  engagementRate: 'Engagement rate',
  engagements: 'Engagements',
  quotes: 'Quotes',
  profileClicks: 'Profile clicks',
  linkClicks: 'Link clicks',
} as const
export const STATES: Record<string, string> = {
  insufficient: 'No stats yet',
  unsupported: 'Not available on this network',
  forbidden: 'Reconnect this account',
  failed: 'Couldn’t load',
  stale: 'May be out of date',
  available: 'Available',
}

/** What an account shows until a network reports its first number. */
export const STATS_PENDING = 'Stats appear about a day after your first post goes live.'

/**
 * No network has reported a number for this account. Published Posts is Shots'
 * own count, so it is not one; a failed metric keeps its card and its retry.
 */
export function noStats(report: AnalyticsReport): boolean {
  return Object.entries(report.metrics).every(
    ([id, metric]) =>
      id === 'publishedPosts' || (metric.value === null && metric.status !== 'failed')
  )
}

/** Stats are still to come, rather than unavailable here, which has its own notice. */
export function statsPending(report: AnalyticsReport): boolean {
  return noStats(report) && report.status !== 'unsupported' && report.status !== 'forbidden'
}

/** The Analyze selection meaning every account of a brand. */
export const brandValue = (setId: string) => `set:${setId}`

/** What Analyze opens on: the account asked for, else a brand whole. One account is its brand. */
export function initialSelection(
  sets: { id: string; accounts: { id: string }[] }[],
  raw: Record<string, string | undefined>
): string {
  if (raw.account && sets.some((set) => set.accounts.some((a) => a.id === raw.account)))
    return raw.account
  const set =
    sets.find((item) => item.id === raw.set && item.accounts.length) ??
    sets.find((item) => item.accounts.length)
  if (!set) return ''
  return set.accounts.length > 1 ? brandValue(set.id) : set.accounts[0].id
}

/**
 * One number across a brand's accounts; an account without it is left out, not
 * counted as zero. Followers overlap between networks, so they are never added.
 */
export function brandTotal(reports: AnalyticsReport[], metric: string): number | null {
  if (metric === 'followers') return null
  const values = reports.flatMap((report) => report.metrics[metric]?.value ?? [])
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null
}

/** One account's report, or the API's own reason it could not load. */
export async function fetchAnalyticsReport(
  url: string,
  signal: AbortSignal
): Promise<AnalyticsReport> {
  const response = await fetch(url, { cache: 'no-store', signal })
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      body.message ??
        (response.status === 404
          ? 'This analytics page is unavailable or sharing has been revoked.'
          : 'Analytics could not load.')
    )
  return readAnalyticsReport(body)
}

/** Rolling month/year presets clamp the day at short-month boundaries. */
export function presetRange(
  preset: string,
  zone: string,
  now = new Date()
): Pick<AnalyticsQuery, 'from' | 'to' | 'grouping'> {
  const today = zonedDayKey(now, zone)
  let from = today,
    to = today
  const start = addDays(today, -((dayOfWeek(today) + 6) % 7))
  if (preset === 'Current week') from = start
  else if (preset === 'Last week') {
    from = addDays(start, -7)
    to = addDays(start, -1)
  } else if (preset === 'Current month') from = `${today.slice(0, 7)}-01`
  else if (preset === 'Last month') {
    to = addDays(`${today.slice(0, 7)}-01`, -1)
    from = `${to.slice(0, 7)}-01`
  } else if (preset === '7 days' || preset === '14 days')
    from = addDays(today, 1 - Number(preset.split(' ')[0]))
  else {
    const months = preset === '1 year' ? 12 : Number(preset.split(' ')[0]) || 1
    const date = new Date(`${today.slice(0, 7)}-01T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() - months)
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
    date.setUTCDate(Math.min(Number(today.slice(8)), last))
    from = addDays(date.toISOString().slice(0, 10), 1)
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1
  return { from, to, grouping: days > 180 ? 'monthly' : days > 45 ? 'weekly' : 'daily' }
}
export function initialQuery(
  raw: Record<string, string | undefined>,
  zone: string
): AnalyticsQuery {
  const defaults = { ...presetRange('1 month', zone), timeZone: zone }
  const result = analyticsQuerySchema.safeParse({
    ...defaults,
    ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  })
  return result.success && isTimeZone(result.data.timeZone)
    ? result.data
    : analyticsQuerySchema.parse(defaults)
}
export function queryString(query: AnalyticsQuery): string {
  return new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)])
  ).toString()
}
export function formatValue(value: number | null | undefined, compact = false): string {
  return value == null
    ? '—'
    : new Intl.NumberFormat(undefined, {
        notation: compact ? 'compact' : 'standard',
        maximumFractionDigits: compact ? 1 : 6,
      }).format(value)
}
/** Growth is undefined for the first observation and after a missing interval. */
export function chartPoints(
  metric: AnalyticsReport['metrics'][string] | null | undefined,
  growth: boolean
) {
  return (metric?.points ?? []).map((point, i, points) => ({
    ...point,
    value: !growth
      ? point.value
      : i === 0 || point.value === null || points[i - 1].value === null
        ? null
        : point.value - points[i - 1].value!,
  }))
}
/** RFC 4180 encoding; text cells cannot execute spreadsheet formulas. */
export function csv(rows: (string | number | null | undefined)[][]): string {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = value == null ? '' : String(value)
            // Control prefixes are part of the spreadsheet formula-injection threat model.
            // eslint-disable-next-line no-control-regex
            if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text))
              text = "'" + text
            return '"' + text.replaceAll('"', '""') + '"'
          })
          .join(',')
      )
      .join('\r\n') +
    '\r\n'
  )
}
export function chartCSV(report: AnalyticsReport, key: string, growth: boolean): string {
  const metric = report.metrics[key]
  return csv([
    [
      'account',
      'platform',
      'metric',
      'from',
      'to',
      'time_zone',
      'grouping',
      'as_of_utc',
      'interval',
      'value',
      'samples',
    ],
    ...chartPoints(metric, growth).map((p) => [
      report.name,
      report.platform,
      key + (growth ? '_growth' : ''),
      report.query.from,
      report.query.to,
      report.query.timeZone,
      report.query.grouping,
      report.asOf,
      p.at,
      p.value,
      p.samples,
    ]),
  ])
}
export function postsCSV(report: AnalyticsReport, rows = report.posts): string {
  const metrics = Object.keys(SORTS).filter((k) => k !== 'latest')
  return csv([
    [
      'account',
      'platform',
      'from',
      'to',
      'time_zone',
      'scope',
      'as_of_utc',
      'post_id',
      'published_at_utc',
      'observed_at_utc',
      'text',
      'url',
      'thread_root',
      'thread_position',
      'reply',
      'availability',
      ...metrics,
    ],
    ...rows.map((row) => [
      report.name,
      report.platform,
      report.query.from,
      report.query.to,
      report.query.timeZone,
      report.query.scope,
      report.asOf,
      row.remoteId,
      row.publishedAt,
      row.observedAt,
      row.excerpt,
      row.url,
      row.threadRootId,
      row.threadPosition,
      String(row.isReply),
      row.status,
      ...metrics.map((key) => row.metrics[key]),
    ]),
  ])
}

import type { accountObservationBuckets } from '@/lib/write/analytics'
import { platformLabel } from '@/lib/content-drafts/serialize'

type Bucket = ReturnType<typeof accountObservationBuckets>[number]

/** Plot each account separately: cumulative counts are never combined across accounts. */
export function AccountMetricCharts({ buckets }: { buckets: Bucket[] }) {
  const series = new Map<string, Bucket[]>()
  for (const bucket of buckets) {
    const key = `${bucket.connection}:${bucket.metric}`
    series.set(key, [...(series.get(key) ?? []), bucket])
  }
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      {[...series].map(([key, points]) => {
        points.sort((a, b) => a.period.localeCompare(b.period))
        const max = Math.max(1, ...points.map((point) => point.value))
        const min = Math.min(0, ...points.map((point) => point.value))
        const first = Date.parse(points[0].period)
        const last = Date.parse(points.at(-1)!.period)
        const x = (point: Bucket) =>
          last === first ? 260 : 55 + ((Date.parse(point.period) - first) / (last - first)) * 405
        const y = (point: Bucket) => 155 - ((point.value - min) / (max - min)) * 130
        const label = `${platformLabel(points[0].platform)} · ${points[0].metric} · ${points[0].connection}`
        return (
          <figure className="min-w-0 rounded border p-3" key={key}>
            <figcaption className="break-words text-sm">{label}</figcaption>
            <svg
              role="img"
              aria-label={`${label}; exact observations in the account metrics table`}
              viewBox="0 0 510 190"
              className="mt-2 w-full text-sky-600 dark:text-sky-400"
            >
              <line x1="55" x2="460" y1="155" y2="155" stroke="currentColor" opacity="0.3" />
              <text x="50" y="29" textAnchor="end" fill="currentColor" fontSize="11">
                {max.toLocaleString()}
              </text>
              <text x="50" y="159" textAnchor="end" fill="currentColor" fontSize="11">
                {min.toLocaleString()}
              </text>
              {points.map((point) => (
                <circle key={point.period} cx={x(point)} cy={y(point)} r="4" fill="currentColor">
                  <title>{`${point.period}: ${point.value.toLocaleString('en-US')} (reported ${point.date})`}</title>
                </circle>
              ))}
              <text x="55" y="180" fill="currentColor" fontSize="11">
                {points[0].period}
              </text>
              {first !== last && (
                <text x="460" y="180" textAnchor="end" fill="currentColor" fontSize="11">
                  {points.at(-1)!.period}
                </text>
              )}
            </svg>
          </figure>
        )
      })}
    </div>
  )
}

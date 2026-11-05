'use client'

import * as React from 'react'
import { DAY_STYLE, useWhen } from '@/components/drafts/local-time'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AnalyticsReport } from '@/lib/api/contracts/plan-analyze'
import { chartPoints, formatValue } from '@/lib/analyze/report'

/** Missing intervals break the line; a zero observation still has a focusable point. */
export function MetricChart({
  metric,
  growth = false,
}: {
  metric: AnalyticsReport['metrics'][string]
  growth?: boolean
}) {
  const when = useWhen()
  // Intervals are calendar days, not moments: read them in UTC so the day stays the one named.
  const day = (at: string) => when(at, 'UTC', DAY_STYLE)
  const points = chartPoints(metric, growth)
  const [active, setActive] = React.useState<number | null>(null)
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]))
  if (!values.length)
    return (
      <p role="status" className="p-6">
        No observations for this series. Collect more history or choose another date range.
      </p>
    )
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values)
  const x = (i: number) => 70 + (i / Math.max(1, points.length - 1)) * 840
  const y = (value: number) => 260 - ((value - min) / (max - min)) * 220
  let path = '',
    previous = false
  points.forEach((point, i) => {
    if (point.value === null) {
      previous = false
      return
    }
    path += `${previous ? 'L' : 'M'}${x(i)},${y(point.value)} `
    previous = true
  })
  return (
    <figure>
      <svg
        viewBox="0 0 960 320"
        className="w-full"
        role="img"
        aria-label={`${growth ? 'Interval growth' : 'Observed values'} from ${day(points[0]!.at)} to ${day(points.at(-1)!.at)}. Exact values are in the data table.`}
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const value = min + ((max - min) * i) / 4
          return (
            <g key={i}>
              <line
                x1="70"
                x2="910"
                y1={y(value)}
                y2={y(value)}
                stroke="currentColor"
                opacity="0.12"
              />
              <text x="60" y={y(value) + 4} textAnchor="end" fontSize="12" fill="currentColor">
                {formatValue(value, true)}
              </text>
            </g>
          )
        })}
        <path d={path} fill="none" stroke="#0284c7" strokeWidth="3" />
        {points.map((p, i) =>
          p.value === null ? null : (
            <circle
              key={p.at}
              cx={x(i)}
              cy={y(p.value)}
              r={active === i ? 6 : 4}
              fill="#0284c7"
              tabIndex={0}
              aria-label={`${day(p.at)}: ${p.value}, ${p.samples} observations`}
              onFocus={() => setActive(i)}
              onMouseEnter={() => setActive(i)}
              onBlur={() => setActive(null)}
              onMouseLeave={() => setActive(null)}
            >
              <title>
                {day(p.at)}: {p.value} ({p.samples} observations)
              </title>
            </circle>
          )
        )}
        <text x="70" y="295" fontSize="14" fill="currentColor">
          {day(points[0]!.at)}
        </text>
        <text x="910" y="295" textAnchor="end" fontSize="14" fill="currentColor">
          {day(points.at(-1)!.at)}
        </text>
      </svg>
      <figcaption className="min-h-6 text-sm">
        {active !== null && points[active]
          ? `${day(points[active].at)}: ${formatValue(points[active].value)} · ${points[active].samples} observations`
          : 'Focus or hover over a point for its value. Gaps indicate missing observations.'}
      </figcaption>
      <Disclosure className="mt-3 text-sm">
        <DisclosureTrigger>Chart data</DisclosureTrigger>
        <DisclosureContent>
          <div className="max-h-64 overflow-auto">
            <Table className="w-full">
              <TableCaption className="sr-only">Exact chart values</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Interval</TableHead>
                  <TableHead scope="col">Value</TableHead>
                  <TableHead scope="col">Observations</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {points.map((p) => (
                  <TableRow key={p.at}>
                    <TableHead scope="row">{day(p.at)}</TableHead>
                    <TableCell>{formatValue(p.value)}</TableCell>
                    <TableCell>{p.samples}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DisclosureContent>
      </Disclosure>
    </figure>
  )
}

/** A single chart render failure cannot remove the rest of the workspace. */
export class ChartBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        This chart could not render.{' '}
        <Button
          variant="custom"
          size={null}
          className="underline"
          onClick={() => this.setState({ failed: false })}
        >
          Retry chart
        </Button>
      </div>
    ) : (
      this.props.children
    )
  }
}

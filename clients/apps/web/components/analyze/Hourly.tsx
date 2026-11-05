'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { useTwelveHour } from '@/components/ui/format-preferences'
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
import type { AnalyticsReport } from '@/lib/api/contracts/plan-analyze'
import { formatValue } from '@/lib/analyze/report'
import { formatTimeOfDay } from '@/lib/time-of-day'
import { InfoTip } from './InfoTip'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Values are lifetime engagement per published post, grouped by local publication hour. */
export function Hourly({
  report,
  onInspect,
}: {
  report: AnalyticsReport
  onInspect: (ids: string[], label: string) => void
}) {
  const twelveHour = useTwelveHour()
  const [mode, setMode] = React.useState('average')
  const [day, setDay] = React.useState(1)
  const cells = report.hourly
  const samples = cells.reduce((n, cell) => n + cell.samples, 0)
  // The page's one empty state covers this: no grid of empty hours.
  if (!samples) return null
  const hourLabel = (hour: number) => formatTimeOfDay(`${hour}:00`, twelveHour)
  const averages = Array.from({ length: 24 }, (_, hour) => {
    const selected = cells.filter((c) => c.hour === hour && (mode === 'average' || c.day === day))
    const count = selected.reduce((n, c) => n + c.samples, 0),
      total = selected.reduce((n, c) => n + c.total, 0)
    return {
      hour,
      samples: count,
      average: count ? total / count : null,
      postIds: selected.flatMap((c) => c.postIds),
    }
  })
  const maximum = Math.max(
    1,
    ...cells.map((c) => c.average ?? 0),
    ...averages.map((c) => c.average ?? 0)
  )
  return (
    <section aria-label="Hourly Engagement" className="rounded-xl border p-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Hourly Engagement</h2>
        <InfoTip label="About Hourly Engagement">
          Lifetime engagements per post, by the time the post was published. This isn’t when the
          engagement happened, and a few posts aren’t enough to pick a best time.
        </InfoTip>
      </div>
      <p className="my-2 text-xs text-muted-foreground">
        Average engagements per post, by publication time in {report.query.timeZone}. Based on{' '}
        {samples} posts.
      </p>
      <div className="my-3 flex gap-2">
        <Label>
          View{' '}
          <Select value={mode} onValueChange={(value) => setMode(value)}>
            <SelectTrigger aria-label="Hourly mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="average">Average</SelectItem>
              <SelectItem value="days">Days</SelectItem>
              <SelectItem value="heatmap">Heatmap</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        {mode === 'days' ? (
          <Label>
            Day{' '}
            <Select value={String(day)} onValueChange={(value) => setDay(Number(value))}>
              <SelectTrigger aria-label="Weekday">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((label, i) => (
                  <SelectItem key={label} value={String(i)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
        ) : null}
      </div>
      {mode === 'heatmap' ? (
        <div className="overflow-x-auto">
          <Table className="w-auto text-xs">
            <TableCaption className="sr-only">
              Seven weekdays by 24 hours, average engagement and sample counts
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                {Array.from({ length: 24 }, (_, i) => (
                  <TableHead key={i}>{hourLabel(i).replace(':00', '')}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {DAYS.map((label, day) => (
                <TableRow key={label}>
                  <TableHead scope="row">{label}</TableHead>
                  {Array.from({ length: 24 }, (_, hour) => {
                    const c = cells.find((v) => v.day === day && v.hour === hour)
                    return (
                      <TableCell className="p-0" key={hour}>
                        <Button
                          variant="custom"
                          size={null}
                          disabled={!c?.samples}
                          onClick={() =>
                            onInspect(
                              c!.postIds,
                              `${label} ${hourLabel(hour)} · ${report.query.timeZone}`
                            )
                          }
                          title={`${label} ${hourLabel(hour)}: ${formatValue(c?.average)} average, ${c?.samples ?? 0} posts`}
                          aria-label={`${label} ${hourLabel(hour)}, ${formatValue(c?.average)} average, ${c?.samples ?? 0} posts`}
                          className="m-0.5 h-8 w-8 rounded border"
                          style={{
                            backgroundColor:
                              c?.average == null
                                ? undefined
                                : `rgba(14,165,233,${0.12 + (c.average / maximum) * 0.8})`,
                          }}
                        >
                          {c?.samples ? formatValue(c.average, true) : '—'}
                        </Button>
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-6 gap-2 sm:grid-cols-12">
          {averages.map((c) => (
            <Button
              variant="custom"
              size={null}
              key={c.hour}
              disabled={!c.samples}
              onClick={() =>
                onInspect(
                  c.postIds,
                  `${mode === 'days' ? DAYS[day] : 'All days'} ${hourLabel(c.hour)} · ${report.query.timeZone}`
                )
              }
              className="rounded border p-2 text-xs"
              title={`${c.samples} posts`}
            >
              <span className="block">{hourLabel(c.hour)}</span>
              <strong>{formatValue(c.average, true)}</strong>
              <span className="block text-muted-foreground">n={c.samples}</span>
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}

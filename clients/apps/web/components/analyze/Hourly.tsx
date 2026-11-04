'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
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

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Values are lifetime engagement per published post, grouped by local publication hour. */
export function Hourly({
  report,
  onInspect,
}: {
  report: AnalyticsReport
  onInspect: (ids: string[], label: string) => void
}) {
  const [mode, setMode] = React.useState('average')
  const [day, setDay] = React.useState(1)
  const cells = report.hourly
  const samples = cells.reduce((n, cell) => n + cell.samples, 0)
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
      <h2 className="font-semibold">Hourly Engagement</h2>
      <p className="my-2 text-xs text-muted-foreground">
        Average observed lifetime engagements per post, by publication time in{' '}
        {report.query.timeZone}. This does not measure when engagement occurred. {samples} posts
        with observations; small samples do not establish a best posting time.
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
      {!samples ? (
        <p role="status">
          Insufficient engagement history. Collect post observations to explore publishing times.
        </p>
      ) : null}
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
                  <TableHead key={i}>{i}</TableHead>
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
                            onInspect(c!.postIds, `${label} ${hour}:00 · ${report.query.timeZone}`)
                          }
                          title={`${label} ${hour}:00: ${formatValue(c?.average)} average, ${c?.samples ?? 0} posts`}
                          aria-label={`${label} ${hour}:00, ${formatValue(c?.average)} average, ${c?.samples ?? 0} posts`}
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
                  `${mode === 'days' ? DAYS[day] : 'All days'} ${c.hour}:00 · ${report.query.timeZone}`
                )
              }
              className="rounded border p-2 text-xs"
              title={`${c.samples} posts`}
            >
              <span className="block">{c.hour}:00</span>
              <strong>{formatValue(c.average, true)}</strong>
              <span className="block text-muted-foreground">n={c.samples}</span>
            </Button>
          ))}
        </div>
      )}
    </section>
  )
}

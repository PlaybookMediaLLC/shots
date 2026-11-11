'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsPageTitle } from './page-title'
import { useNativeSettingsAction, useSelectedDevice } from './device-context'
import { useFounderHubUserId } from './settings-context'

const insightsSchema = z.object({
  conversations: z.number().int().nonnegative(),
  totalConversations: z.number().int().nonnegative(),
  hours: z.number().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  streak: z.number().int().nonnegative(),
  days: z.array(z.object({ key: z.iso.date(), count: z.number().int().nonnegative() })),
  weekdayCounts: z.array(
    z.object({ weekday: z.number().int().min(0).max(6), count: z.number().int().nonnegative() })
  ),
})

/** Insights are computed on the user's desktop; only daily aggregate counts reach Shots. */
export function SettingsInsights() {
  const userId = useFounderHubUserId()
  const device = useSelectedDevice()
  const { run, result, argument, error: actionError, isPending } = useNativeSettingsAction()
  const [range, setRange] = useState<'all' | '30d' | '7d'>('all')
  const [attempt, setAttempt] = useState(0)
  const previous = useRef('')
  const requestKey = `${userId}:${device?.deviceId ?? ''}:${range}:${attempt}`

  useEffect(() => {
    if (!device || previous.current === requestKey) return
    previous.current = requestKey
    run({ kind: 'activity-insights', argument: range, expectedUserId: userId })
  }, [run, device, range, requestKey, userId, attempt])

  let stats: z.infer<typeof insightsSchema> | undefined
  let resultError: string | undefined
  if (result) {
    try {
      stats = insightsSchema.parse(JSON.parse(result))
    } catch {
      resultError = 'The desktop returned invalid activity insights. Try refreshing.'
    }
  }
  const waitingForCurrent = argument !== range
  const error = resultError ?? (actionError && !isPending ? actionError : undefined)
  const weekdayPeak = stats ? Math.max(...stats.weekdayCounts.map((day) => day.count)) : 0
  const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  })

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageTitle title="Your insights" />
      <p className="text-sm text-muted-foreground">
        Activity is calculated on your connected desktop. Shots receives aggregate counts, not
        transcript content.
      </p>
      {!device ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connect a desktop to view your local activity.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <Select
              value={range}
              onValueChange={(value) => setRange(z.enum(['all', '30d', '7d']).parse(value))}
            >
              <SelectTrigger aria-label="Insights date range" className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All time</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Refresh
            </Button>
          </div>
          {isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading your insights…
            </p>
          ) : error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : waitingForCurrent ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading your insights…
            </p>
          ) : stats ? (
            <>
              <dl className="grid gap-3 sm:grid-cols-3">
                <InsightMetric label="Conversations" value={stats.conversations.toLocaleString()} />
                <InsightMetric label="Hours transcribed" value={stats.hours.toFixed(1)} />
                <InsightMetric label="Active days" value={stats.activeDays.toLocaleString()} />
              </dl>
              <section className="flex flex-col gap-3" aria-label="Activity over the past year">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">Activity over the past year</h2>
                  <span className="text-xs text-muted-foreground">
                    Weekly streak: {stats.streak}
                  </span>
                </div>
                <ul
                  className="grid grid-flow-col grid-rows-7 gap-1 overflow-x-auto py-1"
                  aria-label="Daily conversations"
                >
                  {stats.days.map(({ key, count }) => (
                    <li
                      key={key}
                      aria-label={`${key}: ${count} conversations`}
                      title={`${key}: ${count} conversations`}
                      className={`size-3 rounded-sm ${count === 0 ? 'bg-muted' : count < 3 ? 'bg-primary/30' : count < 6 ? 'bg-primary/60' : 'bg-primary'}`}
                    />
                  ))}
                </ul>
              </section>
              {stats.conversations > 0 && (
                <section className="flex flex-col gap-3" aria-label="Conversations by weekday">
                  <h2 className="text-sm font-medium">Your week at a glance</h2>
                  <ul className="flex flex-col gap-2">
                    {stats.weekdayCounts.map(({ weekday, count }) => {
                      const label = weekdayFormatter.format(new Date(Date.UTC(2026, 0, 4 + weekday)))
                      return (
                        <li key={weekday} className="flex items-center gap-3 text-xs">
                          <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
                          <div className="h-5 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
                            <div
                              aria-hidden="true"
                              className={`h-full rounded-sm ${count === weekdayPeak ? 'bg-foreground/70' : 'bg-foreground/20'}`}
                              style={{ width: `${weekdayPeak ? (count / weekdayPeak) * 100 : 0}%` }}
                            />
                          </div>
                          <span className="w-10 shrink-0 text-end tabular-nums">{count}</span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}
              {stats.totalConversations === 0 && (
                <p className="text-sm text-muted-foreground">
                  No conversations with transcripts yet.
                </p>
              )}
              {stats.conversations === 0 && stats.totalConversations > 0 && (
                <p className="text-sm text-muted-foreground">
                  No conversations in this date range.
                </p>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  )
}

function InsightMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  )
}

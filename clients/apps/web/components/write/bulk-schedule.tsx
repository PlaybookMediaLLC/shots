'use client'

import { useState } from 'react'
import type { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { TimePicker } from '@/components/ui/time-picker'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { call, DraftRequestError, draftsApi } from '@/lib/content-drafts/client'
import type { contentDraftScheduleSchema } from '@/lib/api/contracts/content-drafts'
import { zonedDayKey } from '@/lib/settings/zoned-time'
import { readComposing } from '@/lib/write/composing-session'
import { nextSeriesTime } from '@/lib/write/series-time'
import { wallTime } from '@/lib/write/zoned-time'
import { useWrite, useWriteRouter } from './write-context'

type Row = {
  id: string
  title: string
  at: string
  /** The accounts this draft publishes to, as the person knows them. */
  destinations: string[]
  input: z.input<typeof contentDraftScheduleSchema>
  status: 'Blocked' | 'Ready' | 'Scheduled' | 'Retry same request'
  error?: string
}

/**
 * Preflight every selected draft; submit valid rows through ordinary
 * scheduling, one draft (and one post per destination) at a time. A row
 * whose response was lost retries the same request, which replays rather
 * than duplicates; a refused row is corrected and previewed again.
 */
export function BulkScheduleDialog({
  initialMode = 'queue',
  selected,
  onClose,
}: {
  /** A run split out of one paste is spread from a start time, not fitted to slots. */
  initialMode?: 'queue' | 'spread'
  selected: string[]
  onClose: () => void
}) {
  const { data, beforeLeaveRef } = useWrite()
  const router = useWriteRouter()
  const set = data.activeSet
  const [mode, setMode] = useState<'queue' | 'spread'>(initialMode)
  // A run started from the composer continues where the last post left off,
  // at the gap this session has been using; otherwise tomorrow morning.
  const memory = readComposing(set?.id)
  const [start, setStart] = useState(() => {
    const zone = set?.timeZone ?? 'UTC'
    const at = nextSeriesTime({
      gapMinutes: memory.gapMinutes,
      now: new Date(),
      queued: [
        ...data.queue.map((item) => item.at),
        ...(memory.lastScheduledAt ? [memory.lastScheduledAt] : []),
      ],
      slots: [],
    })
    return at
      ? wallTime(at, zone).slice(0, 16)
      : `${zonedDayKey(new Date(Date.now() + 86400_000), zone)}T09:00`
  })
  const [perDay, setPerDay] = useState(2)
  const [spacing, setSpacing] = useState(memory.gapMinutes)
  const [shift, setShift] = useState(0)
  const [seed] = useState(() => crypto.randomUUID())
  const [rows, setRows] = useState<Row[] | null>(null)
  const [skipBlocked, setSkipBlocked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const accounts = new Map(
    data.sets.flatMap((item) =>
      item.accounts.map(
        (account) =>
          [account.id, account.displayName ?? account.handle ?? account.platform] as const
      )
    )
  )
  // Scheduled rows are kept; the rest are validated and timed again. It is
  // offered only once no row awaits an answer, which only its retry may settle.
  const preview = async () => {
    if (!set) return
    setBusy(true)
    setError('')
    setSkipBlocked(false)
    try {
      await beforeLeaveRef.current?.()
      const kept = (rows ?? []).filter((row) => row.status === 'Scheduled')
      const pending = selected.filter((id) => !kept.some((row) => row.id === id))
      // Spread keeps each draft's place in the selection; the queue offers fresh free slots.
      const spread = mode === 'spread'
      const { times } = await call<{ times: string[] }>('/api/v1/content-draft-batch/times', {
        method: 'POST',
        body: {
          socialSetId: set.id,
          count: spread ? selected.length : pending.length,
          mode,
          localTime: start,
          postsPerDay: perDay,
          spacingMinutes: spacing,
          shiftMinutes: shift,
          seed,
        },
      })
      const result: Row[] = []
      for (const [index, id] of pending.entries()) {
        const row: Row = {
          id,
          title: data.library.find((draft) => draft.id === id)?.title ?? id,
          at: times[spread ? selected.indexOf(id) : index],
          destinations: [],
          input: { channelConnectionIds: [], version: 1 },
          status: 'Blocked',
        }
        try {
          const draft = await draftsApi.get(id)
          row.destinations = draft.channelConnectionIds.map(
            (account) => accounts.get(account) ?? account
          )
          if (draft.socialSetId !== set.id) throw new Error('Use one profile per batch.')
          row.input = {
            channelConnectionIds: draft.channelConnectionIds,
            version: draft.version,
            naturalPostingTime: false,
            ...(mode === 'queue'
              ? { queue: true, expectedQueueSlot: row.at }
              : { scheduledFor: row.at }),
          }
          await call(`/api/v1/content-drafts/${id}/schedule/validate`, {
            method: 'POST',
            body: row.input,
          })
          row.status = 'Ready'
        } catch (error) {
          row.error = error instanceof Error ? error.message : 'Validation failed.'
        }
        result.push(row)
      }
      if (mode === 'queue' && result.some((row) => row.status === 'Ready')) {
        const ready = result.filter((row) => row.status === 'Ready')
        const replanned = await call<{ times: string[] }>('/api/v1/content-draft-batch/times', {
          method: 'POST',
          body: { socialSetId: set.id, count: ready.length, mode, seed },
        })
        ready.forEach((row, index) => {
          row.at = replanned.times[index]
          row.input.expectedQueueSlot = row.at
        })
      }
      setRows([...kept, ...result])
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The batch could not be prepared.')
    } finally {
      setBusy(false)
    }
  }
  const schedule = async () => {
    if (!rows) return
    setBusy(true)
    const next = [...rows]
    for (const [index, row] of next.entries()) {
      if (row.status !== 'Ready' && row.status !== 'Retry same request') continue
      try {
        await draftsApi.schedule(row.id, row.input)
        next[index] = { ...row, status: 'Scheduled', error: undefined }
      } catch (error) {
        // A refusal needs a correction and a new preview; only an unanswered
        // request is retried as is, which replays instead of duplicating.
        const refused = error instanceof DraftRequestError && error.status < 500
        next[index] = {
          ...row,
          status: refused ? 'Blocked' : 'Retry same request',
          error: refused
            ? `${error.message} Correct it, then preview the remaining drafts again.`
            : 'No confirmation was received. Retrying sends the same request, so it cannot schedule twice.',
        }
      }
      setRows([...next])
    }
    setBusy(false)
    router.refresh()
  }
  const blocked = rows?.filter((row) => row.status === 'Blocked').length ?? 0
  const unconfirmed = rows?.some((row) => row.status === 'Retry same request') ?? false
  const submittable =
    rows?.filter((row) => row.status === 'Ready' || row.status === 'Retry same request').length ?? 0
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Schedule {selected.length} drafts</DialogTitle>
          <DialogDescription>
            Preview all times in {set?.timeZone}. Drafts needing approval remain blocked. Each
            scheduled destination uses the normal publishing quota.
          </DialogDescription>
        </DialogHeader>
        {!rows ? (
          <>
            <Label>
              Mode{' '}
              <Select
                value={mode}
                disabled={busy}
                onValueChange={(value) => setMode(value as 'queue' | 'spread')}
              >
                <SelectTrigger aria-label="Batch mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="queue">Fill the queue</SelectItem>
                  <SelectItem value="spread">Spread</SelectItem>
                </SelectContent>
              </Select>
            </Label>
            {mode === 'spread' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Label className="grid gap-1">
                  Start
                  <span className="grid grid-cols-2 gap-2">
                    <DatePicker
                      aria-label="Start day"
                      className="w-full"
                      value={start.slice(0, 10)}
                      onChange={(day) => setStart(`${day}T${start.slice(11)}`)}
                    />
                    <TimePicker
                      aria-label="Start time"
                      className="w-full"
                      value={start.slice(11)}
                      onChange={(time) => setStart(`${start.slice(0, 10)}T${time}`)}
                    />
                  </span>
                </Label>
                <Label className="grid gap-1">
                  Posts per day
                  <Input
                    type="number"
                    min={1}
                    max={24}
                    value={perDay}
                    onChange={(event) => setPerDay(Number(event.target.value))}
                  />
                </Label>
                <Label className="grid gap-1">
                  Spacing in minutes
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={spacing}
                    onChange={(event) => setSpacing(Number(event.target.value))}
                  />
                </Label>
                <Label className="grid gap-1">
                  Random shift in minutes
                  <Input
                    type="number"
                    min={0}
                    max={55}
                    step={5}
                    value={shift}
                    onChange={(event) => setShift(Number(event.target.value))}
                  />
                </Label>
              </div>
            )}
            <Button disabled={busy || selected.length > 50} onClick={() => void preview()}>
              {busy ? 'Checking drafts…' : 'Preview and validate'}
            </Button>
            {selected.length > 50 && <p role="alert">Select at most 50 drafts.</p>}
          </>
        ) : (
          <>
            <ol className="grid gap-2 text-sm">
              {rows.map((row, index) => (
                <li className="rounded border p-3" key={row.id}>
                  <strong>
                    {index + 1}. {row.title}
                  </strong>
                  <p>
                    {new Date(row.at).toLocaleString(undefined, { timeZone: set?.timeZone })} ·{' '}
                    {row.status}
                  </p>
                  {row.destinations.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      To {row.destinations.join(', ')}: one post each, at this time.
                    </p>
                  ) : null}
                  {row.error && <p role="alert">{row.error}</p>}
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              A changed queue or draft is refused, never moved silently. Retrying an unconfirmed row
              keeps its version and request, so it cannot create a duplicate. Scheduled rows stay
              scheduled when you preview the rest again.
            </p>
            {blocked > 0 && submittable > 0 ? (
              <Label className="flex items-center gap-2 text-sm" data-testid="skip-blocked">
                <Checkbox
                  checked={skipBlocked}
                  onCheckedChange={(checked) => setSkipBlocked(checked === true)}
                />
                Schedule the {submittable} valid {submittable === 1 ? 'draft' : 'drafts'} and leave
                the {blocked} blocked {blocked === 1 ? 'one' : 'ones'} unscheduled
              </Label>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || submittable === 0 || (blocked > 0 && !skipBlocked)}
                onClick={() => void schedule()}
              >
                {busy
                  ? 'Scheduling…'
                  : rows.some((row) => row.status === 'Retry same request')
                    ? 'Retry unconfirmed rows'
                    : `Schedule valid drafts (${submittable})`}
              </Button>
              {blocked > 0 && !unconfirmed ? (
                <Button disabled={busy} onClick={() => void preview()} variant="outline">
                  Preview the remaining drafts again
                </Button>
              ) : null}
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

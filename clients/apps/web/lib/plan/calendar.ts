import { z } from 'zod'
import { addDays, dayOfWeek, zonedDayKey } from '@/lib/settings/zoned-time'
import { isTimeZone, resolveLocalTime } from '@/lib/write/zoned-time'
import { availableDaySlots } from '@/lib/write/calendar'
import { wallTime } from '@/lib/write/zoned-time'
import { statusGroup } from '@/lib/content-drafts/post-status'

export const planPreferencesSchema = z.object({
  view: z.enum(['flex', 'month', 'week']).default('flex'),
  density: z.enum(['expanded', 'compact']).default('expanded'),
  platforms: z.boolean().default(true),
  tags: z.boolean().default(true),
  slots: z.boolean().default(true),
  weekStart: z.union([z.literal(0), z.literal(1)]).default(1),
  zone: z.string().refine(isTimeZone).default('UTC'),
  visible: z.array(z.string()).nullable().default(null),
  statuses: z.array(z.string()).default([]),
  providers: z.array(z.string()).default([]),
  tagIds: z.array(z.string()).default([]),
})
export type PlanPreferences = z.infer<typeof planPreferencesSchema>
export type PlanItem = {
  id: string
  draftId: string
  campaignId?: string | null
  version: number
  calendarVersion: number
  postId?: string
  setId: string
  accountId?: string
  platform: string
  at: string
  /** A post's publication instant: its slot (`at`) plus any natural offset. */
  publishAt?: string
  zone: string
  deliveryStatus?: string
  /** Why a post did not publish, as its backend records it. */
  failureCode?: string | null
  status: string
  title: string
  text: string
  tagIds: string[]
  url?: string | null
}

export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const at = new Date(`${day}T12:00:00Z`)
  return Number.isFinite(at.getTime()) && at.toISOString().slice(0, 10) === day
}
export function startOfWeek(day: string, first: number): string {
  return addDays(day, -((dayOfWeek(day) - first + 7) % 7))
}
export function calendarDays(
  anchor: string,
  view: PlanPreferences['view'],
  first: number,
  weeks = 3
): string[] {
  if (!validDay(anchor)) throw new Error('Invalid calendar anchor.')
  const firstMonth = `${anchor.slice(0, 7)}-01`
  const start = startOfWeek(view === 'month' ? firstMonth : anchor, first)
  let count = view === 'week' ? 7 : Math.max(1, Math.min(8, weeks)) * 7
  if (view === 'month') {
    const next = new Date(`${firstMonth}T12:00:00Z`)
    next.setUTCMonth(next.getUTCMonth() + 1)
    const days = (next.getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86400000
    count = Math.ceil(days / 7) * 7
  }
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}
export function shiftAnchor(
  anchor: string,
  view: PlanPreferences['view'],
  amount: number,
  weeks: number
): string {
  if (view !== 'month') return addDays(anchor, amount * 7 * (view === 'flex' ? weeks : 1))
  const at = new Date(`${anchor.slice(0, 7)}-01T12:00:00Z`)
  at.setUTCMonth(at.getUTCMonth() + amount)
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate()
  at.setUTCDate(Math.min(Number(anchor.slice(8)), last))
  return at.toISOString().slice(0, 10)
}
export function visibleItems(items: PlanItem[], p: PlanPreferences): PlanItem[] {
  return items.filter(
    (item) =>
      (p.visible === null || p.visible.includes(item.setId)) &&
      (!p.statuses.length || p.statuses.includes(statusGroup(item.status))) &&
      (!p.providers.length || p.providers.includes(item.platform)) &&
      (!p.tagIds.length || p.tagIds.some((id) => item.tagIds.includes(id)))
  )
}
export function selectionState(visible: string[] | null, ids: string[]): 'all' | 'none' | 'mixed' {
  const count = ids.filter((id) => visible === null || visible.includes(id)).length
  return count === 0 ? 'none' : count === ids.length ? 'all' : 'mixed'
}
export function selectedInstant(
  local: string,
  zone: string,
  choice: 'reject' | 'earlier' | 'later',
  now = new Date()
): Date {
  if (!validDay(local.slice(0, 10))) throw new Error('Choose a valid date.')
  const resolved = resolveLocalTime(local, zone)
  if (resolved.kind === 'gap') throw new Error('The clocks skip this time. Choose another time.')
  if (resolved.kind === 'ambiguous' && choice === 'reject')
    throw new Error('This time occurs twice. Choose earlier or later.')
  const at = resolved.kind === 'exact' ? resolved.at : resolved[choice as 'earlier' | 'later']
  if (at <= now) throw new Error('Choose a future time.')
  return at
}
export function itemDay(item: PlanItem, zone: string): string {
  return zonedDayKey(new Date(item.at), zone)
}

/**
 * A card dropped on another displayed day keeps its time in its own
 * scheduling zone, moved by the days between the two displayed days: a
 * display zone across a daylight-saving change never shifts its clock.
 */
export function movedToDay(
  at: string,
  postZone: string,
  displayZone: string,
  day: string,
  now = new Date()
): Date {
  const instant = new Date(at)
  const days = Math.round(
    (Date.parse(`${day}T12:00:00Z`) -
      Date.parse(`${zonedDayKey(instant, displayZone)}T12:00:00Z`)) /
      86_400_000
  )
  const wall = wallTime(instant, postZone)
  return selectedInstant(
    `${addDays(wall.slice(0, 10), days)}T${wall.slice(11)}`,
    postZone,
    'reject',
    now
  )
}

/** States whose post holds its queue slot, as the backend's free-slot search counts them. */
const SLOT_HOLDERS = new Set(['Scheduled', 'Overdue', 'Publishing', 'Needs check'])

/** The slot instants a brand's queued posts hold; planned, failed and published items free theirs. */
export function takenSlots(items: PlanItem[], setId: string): string[] {
  return items
    .filter((item) => item.setId === setId && SLOT_HOLDERS.has(item.status))
    .map((item) => item.at)
}

/** Reserve a separate lane for every overlapping card, including repeated DST hours. */
export function weekCardLayout(items: PlanItem[], zone: string, height: number) {
  const ends: number[] = []
  const cards = items
    .map((item) => {
      const [hour, minute] = wallTime(new Date(item.at), zone).slice(11).split(':').map(Number)
      return { item, top: hour * 60 + minute }
    })
    .sort(
      (a, b) =>
        a.top - b.top || a.item.at.localeCompare(b.item.at) || a.item.id.localeCompare(b.item.id)
    )
    .map(({ item, top }) => {
      const available = ends.findIndex((end) => end <= top)
      const lane = available < 0 ? ends.length : available
      ends[lane] = top + height + 4
      return { item, top, lane }
    })
  return { cards, lanes: Math.max(1, ends.length) }
}

/** Slots belong to the account's zone; locate them on the displayed calendar without rewriting them. */
export function displayDaySlots(
  day: string,
  displayZone: string,
  scheduleZone: string,
  slots: { weekday: number; time: string }[],
  taken: string[],
  now = new Date()
) {
  return [-2, -1, 0, 1, 2]
    .flatMap((offset) => {
      const localDay = addDays(day, offset)
      return availableDaySlots(localDay, scheduleZone, slots, taken, now).flatMap((time) => {
        const resolved = resolveLocalTime(`${localDay}T${time}`, scheduleZone)
        if (resolved.kind !== 'exact' || zonedDayKey(resolved.at, displayZone) !== day) return []
        return [
          {
            at: resolved.at.toISOString(),
            localDay,
            localTime: time,
            displayTime: wallTime(resolved.at, displayZone).slice(11),
          },
        ]
      })
    })
    .sort((a, b) => a.at.localeCompare(b.at))
}

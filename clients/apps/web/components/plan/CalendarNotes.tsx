'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  calendarNoteColorSchema,
  calendarNoteSchema,
  type CalendarNoteWire,
} from '@/lib/api/contracts/calendar-notes'
import { call } from '@/lib/content-drafts/client'
import { useHydratedSession } from '@/lib/auth/client'
import { trackPostManagementUse } from '@/lib/plan/feature-use'
import { readWire } from '@/lib/plan/wire'

const COLORS: Record<CalendarNoteWire['color'], { dot: string; edge: string }> = {
  blue: { dot: 'bg-blue-500', edge: 'border-l-blue-500' },
  green: { dot: 'bg-green-500', edge: 'border-l-green-500' },
  red: { dot: 'bg-red-500', edge: 'border-l-red-500' },
  yellow: { dot: 'bg-yellow-500', edge: 'border-l-yellow-500' },
  purple: { dot: 'bg-purple-500', edge: 'border-l-purple-500' },
  orange: { dot: 'bg-orange-500', edge: 'border-l-orange-500' },
}

/**
 * A note on a calendar day. `compact` is a dot, for the week view's fixed-height
 * day header, where a full chip would push that column's hours out of line.
 */
export function NoteChip({
  note,
  compact = false,
  onOpen,
}: {
  note: CalendarNoteWire
  compact?: boolean
  /** Absent when the person cannot edit notes. */
  onOpen?: () => void
}) {
  const content = compact ? (
    <span className={`block size-2.5 rounded-full ${COLORS[note.color].dot}`} />
  ) : (
    note.title
  )
  const className = compact
    ? 'block rounded-full p-1'
    : `block w-full truncate rounded border-l-4 bg-muted px-2 py-1 text-left text-xs font-normal ${COLORS[note.color].edge}`
  const label = `Note: ${note.title}`
  return onOpen ? (
    <Button
      aria-label={label}
      className={`h-auto ${className}`}
      data-testid="calendar-note"
      onClick={onOpen}
      size={null}
      title={note.title}
      variant="custom"
    >
      {content}
    </Button>
  ) : (
    <span
      aria-label={label}
      className={className}
      data-testid="calendar-note"
      role="note"
      title={note.title}
    >
      {content}
    </span>
  )
}

/** Add a note to a day, or change or delete one. */
export function NoteDialog({
  day,
  dayLabel,
  note,
  onClose,
  onSaved,
}: {
  day: string
  dayLabel: string
  note?: CalendarNoteWire
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = React.useState(note?.title ?? '')
  const [color, setColor] = React.useState<CalendarNoteWire['color']>(note?.color ?? 'blue')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const colorLabel = React.useId()
  const workspaceId = useHydratedSession().data?.session.activeOrganizationId
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await request()
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The note could not be saved.')
      setBusy(false)
    }
  }
  const save = () =>
    run(async () => {
      readWire(
        calendarNoteSchema,
        await call(note ? `/api/v1/calendar/notes/${note.id}` : '/api/v1/calendar/notes', {
          method: note ? 'PATCH' : 'POST',
          body: note ? { title, color } : { day, title, color },
        })
      )
      if (!note) trackPostManagementUse(workspaceId, 'calendar_note')
    })
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{note ? 'Edit note' : 'Add note'}</DialogTitle>
          <DialogDescription>
            {dayLabel}. Visible to everyone in this workspace. A note never publishes.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim()) void save()
          }}
        >
          <Label className="grid gap-1.5">
            Title
            <Input
              autoFocus
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              value={title}
            />
          </Label>
          <div className="grid gap-1.5">
            <Label id={colorLabel}>Color</Label>
            <RadioGroup
              aria-labelledby={colorLabel}
              className="flex flex-wrap gap-3"
              onValueChange={(value) => setColor(value as CalendarNoteWire['color'])}
              value={color}
            >
              {calendarNoteColorSchema.options.map((option) => (
                <Label className="flex items-center gap-1.5 font-normal capitalize" key={option}>
                  <RadioGroupItem value={option} />
                  <span className={`size-2.5 rounded-full ${COLORS[option].dot}`} />
                  {option}
                </Label>
              ))}
            </RadioGroup>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2">
            {note ? (
              <Button
                className="mr-auto"
                disabled={busy}
                onClick={() =>
                  void run(() => call(`/api/v1/calendar/notes/${note.id}`, { method: 'DELETE' }))
                }
                type="button"
                variant="outline"
              >
                Delete note
              </Button>
            ) : null}
            <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={busy || !title.trim()} type="submit">
              {note ? 'Save note' : 'Add note'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

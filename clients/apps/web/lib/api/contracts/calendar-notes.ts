import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { contentDraftIdSchema } from './content-drafts'
import { memberDocs } from './workspace-docs'

const entitlement = { 'x-shots-entitlement': { feature: 'content:drafts', minimumPlan: 'pro' } }
const params = z.object({ id: contentDraftIdSchema })

/** The colors a calendar note can have. */
export const calendarNoteColorSchema = z.enum([
  'blue',
  'green',
  'red',
  'yellow',
  'purple',
  'orange',
])
/** A note's editable fields. */
export const calendarNoteChangesSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  color: calendarNoteColorSchema,
})
/** A new note on a date. The date has no zone and is never converted. */
export const calendarNoteInputSchema = calendarNoteChangesSchema.extend({ day: z.iso.date() })
/** A workspace's note on a calendar date. It is not a post and never publishes. */
export const calendarNoteSchema = z.object({
  id: contentDraftIdSchema,
  day: z.iso.date(),
  title: z.string(),
  color: calendarNoteColorSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
})
/** A note as the calendar reads it. */
export type CalendarNoteWire = z.infer<typeof calendarNoteSchema>
/** A list of notes. */
export const calendarNoteListSchema = z.object({ items: z.array(calendarNoteSchema) })
/** The workspace's notes on an inclusive range of days. */
export const listCalendarNotesContract = defineContract({
  access: { permission: 'artifact:read', feature: 'content:drafts' },
  method: 'GET',
  name: 'calendar.notes.list',
  path: '/api/v1/calendar/notes',
  query: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  output: calendarNoteListSchema,
  summary: 'List calendar notes',
  docs: memberDocs({
    operationId: 'listCalendarNotes',
    outputName: 'CalendarNoteList',
    description:
      'Date-only notes visible to everyone in the workspace, at most 100 days at a time.',
    extensions: entitlement,
    responses: { '200': 'The notes in the range.' },
    tag: 'Workspace',
  }),
})
/** Add a note to a date. */
export const createCalendarNoteContract = defineContract({
  access: { permission: 'artifact:edit', feature: 'content:drafts' },
  method: 'POST',
  name: 'calendar.notes.create',
  path: '/api/v1/calendar/notes',
  body: calendarNoteInputSchema,
  output: calendarNoteSchema,
  status: 201,
  summary: 'Add a calendar note',
  docs: memberDocs({
    operationId: 'createCalendarNote',
    outputName: 'CalendarNote',
    description: 'Adds a note to a date. A note is not a post and never publishes.',
    extensions: entitlement,
    responses: { '201': 'The note.' },
    tag: 'Workspace',
  }),
})
/** Change a note's title and color. Its date stays. */
export const updateCalendarNoteContract = defineContract({
  access: { permission: 'artifact:edit', feature: 'content:drafts' },
  method: 'PATCH',
  name: 'calendar.notes.update',
  path: '/api/v1/calendar/notes/{id}',
  params,
  body: calendarNoteChangesSchema,
  output: calendarNoteSchema,
  summary: 'Edit a calendar note',
  docs: memberDocs({
    operationId: 'updateCalendarNote',
    outputName: 'CalendarNote',
    description: "Changes a note's title and color. Its date stays.",
    extensions: entitlement,
    responses: { '200': 'The note.', '404': 'The note is not in this workspace.' },
    tag: 'Workspace',
  }),
})
/** Delete a note. */
export const deleteCalendarNoteContract = defineContract({
  access: { permission: 'artifact:edit', feature: 'content:drafts' },
  method: 'DELETE',
  name: 'calendar.notes.delete',
  path: '/api/v1/calendar/notes/{id}',
  params,
  output: z.object({ deleted: z.boolean() }),
  summary: 'Delete a calendar note',
  docs: memberDocs({
    operationId: 'deleteCalendarNote',
    description: 'Deletes a note from this workspace.',
    extensions: entitlement,
    responses: { '200': 'Deleted.', '404': 'The note is not in this workspace.' },
    tag: 'Workspace',
  }),
})

import {
  calendarNoteListSchema,
  calendarNoteSchema,
  createCalendarNoteContract,
  listCalendarNotesContract,
} from '@/lib/api/contracts/calendar-notes'
import { route, errorResponse } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** listCalendarNotesContract: authenticated, workspace-scoped backend operation. */
export const GET = route(listCalendarNotesContract, {
  auth: memberAccess(listCalendarNotesContract.access),
  handler: async ({ access, query }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content workspace is unavailable.')
    return calendarNoteListSchema.parse(
      await backendSDK(access).listCalendarNotes(query.from, query.to)
    )
  },
})

/** createCalendarNoteContract: authenticated, workspace-scoped backend operation. */
export const POST = route(createCalendarNoteContract, {
  auth: memberAccess(createCalendarNoteContract.access),
  handler: async ({ access, body }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content workspace is unavailable.')
    return calendarNoteSchema.parse(await backendSDK(access).createCalendarNote(body))
  },
})

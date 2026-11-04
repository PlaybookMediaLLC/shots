import {
  calendarNoteSchema,
  deleteCalendarNoteContract,
  updateCalendarNoteContract,
} from '@/lib/api/contracts/calendar-notes'
import { route, errorResponse } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** updateCalendarNoteContract: authenticated, workspace-scoped backend operation. */
export const PATCH = route(updateCalendarNoteContract, {
  auth: memberAccess(updateCalendarNoteContract.access),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content workspace is unavailable.')
    return calendarNoteSchema.parse(await backendSDK(access).updateCalendarNote(params.id, body))
  },
})

/** deleteCalendarNoteContract: authenticated, workspace-scoped backend operation. */
export const DELETE = route(deleteCalendarNoteContract, {
  auth: memberAccess(deleteCalendarNoteContract.access),
  handler: async ({ access, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content workspace is unavailable.')
    return backendSDK(access).deleteCalendarNote(params.id)
  },
})

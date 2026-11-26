import 'server-only'

import { z } from 'zod'
import { savedEntries, savedEntrySchema, SAVED_ENTRIES_MAX } from '@/lib/assistant/saved-thread'
import { backendSDK } from '@/lib/backend/sdk'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

/**
 * The signed-in person's saved assistant threads in the active workspace. Go
 * scopes every read and write to that person; another person's id is a 404.
 */

const threadId = z.uuid()

export const assistantThreadRouter = router({
  list: organizationProcedure('workspace:read').query(async ({ ctx }) =>
    (await backendSDK(ctx.access).listAssistantThreads()).threads.map(
      ({ id, title, updatedAt }) => ({ id, title, updatedAt })
    )
  ),

  get: organizationProcedure('workspace:read')
    .input(z.object({ id: threadId }))
    .query(async ({ ctx, input }) => {
      const thread = await backendSDK(ctx.access).getAssistantThread(input.id)
      return { entries: savedEntries(thread.entries ?? []), id: thread.id }
    }),

  save: organizationProcedure('workspace:read')
    .input(
      z.object({
        entries: z.array(savedEntrySchema).min(1).max(SAVED_ENTRIES_MAX),
        id: threadId,
        title: z.string().trim().min(1).max(120),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await backendSDK(ctx.access).saveAssistantThread(input.id, {
        entries: input.entries,
        title: input.title,
      })
      return { saved: true }
    }),

  remove: organizationProcedure('workspace:read')
    .input(z.object({ id: threadId }))
    .mutation(({ ctx, input }) => backendSDK(ctx.access).deleteAssistantThread(input.id)),
})

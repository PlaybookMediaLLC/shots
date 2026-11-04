import 'server-only'

import { z } from 'zod'
import {
  cancelBackendScheduledPost,
  createBackendConnection,
  createBackendScheduledPost,
  listBackendConnections,
  listBackendScheduledPosts,
  refreshBackendConnection,
  removeBackendConnection,
} from '@/lib/tenant/publishing-backend'
import { getScheduledPostIdempotencyKey } from '@/lib/tenant/scheduled-posts'
import {
  channelConnectionCreateSchema,
  hasOneScheduledPostSource,
  scheduledPostCreateSchema,
  scheduledPostListQuerySchema,
} from '@/lib/tenant/schemas'
import { router } from '../init'
import { organizationProcedure, sensitiveOrganizationProcedure } from '../procedures'

export const channelConnectionRouter = router({
  list: organizationProcedure('publish:manage').query(async ({ ctx }) => ({
    connections: await listBackendConnections(ctx.access),
  })),
  create: sensitiveOrganizationProcedure('connection:manage')
    .input(channelConnectionCreateSchema)
    .mutation(async ({ ctx, input }) => ({
      connection: await createBackendConnection(ctx.access, input),
    })),
  remove: organizationProcedure('connection:manage')
    .input(z.object({ connectionId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => removeBackendConnection(ctx.access, input.connectionId)),
  refresh: organizationProcedure('connection:manage')
    .input(z.object({ connectionId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => ({
      connection: await refreshBackendConnection(ctx.access, input.connectionId),
    })),
})

export const scheduledPostRouter = router({
  list: organizationProcedure('publish:manage')
    .input(scheduledPostListQuerySchema.optional())
    .query(async ({ ctx, input }) => ({
      scheduledPosts: await listBackendScheduledPosts(ctx.access, input?.limit ?? 50),
    })),
  create: sensitiveOrganizationProcedure('publish:manage')
    .input(
      scheduledPostCreateSchema
        .extend({ idempotencyKey: z.string().trim().min(1).max(128).optional() })
        .refine(hasOneScheduledPostSource, {
          message: 'Give exactly one of variantId and contentDraftId.',
          path: ['variantId'],
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { idempotencyKey, ...post } = input
      return createBackendScheduledPost(ctx.access, {
        ...post,
        idempotencyKey: getScheduledPostIdempotencyKey(idempotencyKey ?? null),
      })
    }),
  cancel: sensitiveOrganizationProcedure('publish:manage')
    .input(z.object({ scheduledPostId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) =>
      cancelBackendScheduledPost(ctx.access, input.scheduledPostId)
    ),
})

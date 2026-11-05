import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  captureProductSurface,
  createProductSurface,
  deleteProductSurface,
  findSurfacesForFeature,
  listProductSurfaces,
  listSurfaceCaptures,
  updateProductSurface,
} from '@/lib/tenant/product-surfaces'
import { productSurfaceCreateSchema, productSurfaceUpdateSchema } from '@/lib/tenant/schemas'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

const surfaceIdSchema = z.string().cuid()

export const productSurfaceRouter = router({
  // Any member who can read campaigns can see which surfaces they link to.
  list: organizationProcedure('artifact:read').query(async ({ ctx }) => {
    const productSurfaces = await listProductSurfaces(ctx.access)
    return { productSurfaces }
  }),
  /** A surface's capture history, newest first; the current capture has no `supersededAt`. */
  captures: organizationProcedure('artifact:read')
    .input(z.object({ surfaceId: surfaceIdSchema }))
    .query(async ({ ctx, input }) => {
      const captures = await listSurfaceCaptures(ctx.access, input.surfaceId)
      if (!captures) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product surface not found.' })
      }
      return { captures }
    }),
  /** Surfaces for a feature, ranked with no model; a `fallback` match is not the feature's screen. */
  match: organizationProcedure('artifact:read')
    .input(
      z.object({
        feature: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(20).optional(),
        tags: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      })
    )
    .query(async ({ ctx, input }) => ({
      matches: await findSurfacesForFeature(ctx.access, input),
    })),
  /** Screenshot the surface's page now; a signed-in page returns the job capturing it instead. */
  capture: organizationProcedure('brand:manage')
    .input(z.object({ surfaceId: surfaceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await captureProductSurface(ctx.access, input.surfaceId)
      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product surface not found.' })
      }
      if ('failure' in result) {
        throw new TRPCError({
          code: result.failure.status === 429 ? 'TOO_MANY_REQUESTS' : 'BAD_REQUEST',
          message: result.failure.message,
        })
      }
      return 'job' in result ? { job: result.job } : { capture: result.capture }
    }),
  create: organizationProcedure('brand:manage')
    .input(productSurfaceCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const productSurface = await createProductSurface(ctx.access, input)
      return { productSurface }
    }),
  update: organizationProcedure('brand:manage')
    .input(productSurfaceUpdateSchema.extend({ surfaceId: surfaceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { surfaceId, ...update } = input
      const productSurface = await updateProductSurface(ctx.access, surfaceId, update)
      if (!productSurface) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product surface not found.' })
      }
      return { productSurface }
    }),
  delete: organizationProcedure('brand:manage')
    .input(z.object({ surfaceId: surfaceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteProductSurface(ctx.access, input.surfaceId)
      if (!deleted) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Product surface not found.' })
      }
      return { deleted: true as const }
    }),
})

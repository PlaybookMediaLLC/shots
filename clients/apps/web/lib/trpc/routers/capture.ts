import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import {
  captureConnectFinishSchema,
  captureConnectionInputSchema,
  captureConnectionSchema,
  captureConnectStartSchema,
  captureIdentitySchema,
  captureJobSchema,
  captureOverviewSchema,
  captureRecipeInputSchema,
  captureRecipeSchema,
} from '@/lib/api/contracts/capture'
import { backendSDK } from '@/lib/backend/sdk'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

/** The backend's 409s speak of a publishing resource; say what the person can do instead. */
async function explainConflict<T>(request: Promise<T>, message: string): Promise<T> {
  try {
    return await request
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 409) {
      throw new TRPCError({ cause: error, code: 'CONFLICT', message })
    }
    throw error
  }
}

/** Members read; only an owner or admin session manages capture, and Go checks again. */
export const captureRouter = router({
  overview: organizationProcedure('workspace:read')
    .output(captureOverviewSchema)
    .query(({ ctx }) => backendSDK(ctx.access).captureOverview()),
  createConnection: organizationProcedure('workspace:update')
    .input(captureConnectionInputSchema)
    .output(z.object({ connection: captureConnectionSchema }))
    .mutation(({ ctx, input }) =>
      explainConflict(
        backendSDK(ctx.access).createCaptureConnection(input),
        'A connection with this name already exists. Choose another name.'
      )
    ),
  /**
   * Returns the Live View link, a bearer credential: nothing here may log or
   * store it. The tRPC route answers every procedure with no-store.
   */
  connect: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .output(captureConnectStartSchema)
    .mutation(({ ctx, input }) =>
      explainConflict(
        backendSDK(ctx.access).startCaptureConnect(input.id),
        'This connection was revoked. Create a new one to sign in again.'
      )
    ),
  finishConnect: organizationProcedure('workspace:update')
    .input(captureConnectFinishSchema)
    .mutation(({ ctx, input }) =>
      explainConflict(
        backendSDK(ctx.access).finishCaptureConnect(input.id, input.intentId),
        'This sign-in expired or was replaced. Start the sign-in again.'
      )
    ),
  revokeConnection: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).revokeCaptureConnection(input.id)),
  createRecipe: organizationProcedure('workspace:update')
    .input(captureRecipeInputSchema)
    .output(z.object({ recipe: captureRecipeSchema }))
    .mutation(({ ctx, input }) =>
      explainConflict(
        backendSDK(ctx.access).createCaptureRecipe(input),
        'This connection was revoked, or this version was just saved. Reload and try again.'
      )
    ),
  activateRecipe: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .output(z.object({ recipe: captureRecipeSchema }))
    .mutation(({ ctx, input }) => backendSDK(ctx.access).activateCaptureRecipe(input.id)),
  archiveRecipe: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).archiveCaptureRecipe(input.id)),
  /** A test never replaces the screen's current image. Other captures go through its surface. */
  testRecipe: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .output(z.object({ job: captureJobSchema }))
    .mutation(({ ctx, input }) =>
      explainConflict(
        backendSDK(ctx.access).requestCaptureJob(input.id, { test: true }),
        'This version was archived or its connection was revoked, so it cannot run.'
      )
    ),
  cancelJob: organizationProcedure('workspace:update')
    .input(captureIdentitySchema)
    .mutation(({ ctx, input }) => backendSDK(ctx.access).cancelCaptureJob(input.id)),
})

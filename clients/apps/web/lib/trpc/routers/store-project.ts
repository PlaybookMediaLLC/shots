import 'server-only'

import { TRPCError } from '@trpc/server'
import type { TenantAccessRequirement } from '@/lib/api/access-requirements'
import {
  storeProjectCreateInputSchema,
  storeProjectDocumentInputSchema,
  storeProjectListInputSchema,
  storeProjectRefInputSchema,
} from '@/lib/store-screenshots/workspace-schema'
import {
  createStoreProject,
  deleteStoreProject,
  getStoreProject,
  listStoreProjects,
  updateStoreProjectDocument,
} from '@/lib/tenant/store-projects'
import { router } from '../init'
import { tenantProcedure } from '../procedures'

const READ: TenantAccessRequirement = { apiKeyScope: 'artifact:read', permission: 'artifact:read' }
const EDIT: TenantAccessRequirement = { apiKeyScope: 'asset:write', permission: 'artifact:edit' }

/**
 * Store screenshot projects saved to the workspace: Library's list and delete,
 * and the studio's first save, autosave and download on another device. A document
 * write based on an older revision fails with `CONFLICT`.
 */
export const storeProjectRouter = router({
  list: tenantProcedure(READ)
    .input(storeProjectListInputSchema)
    .query(({ ctx, input }) => listStoreProjects(ctx.tenant, input)),
  get: tenantProcedure(READ)
    .input(storeProjectRefInputSchema)
    .query(async ({ ctx, input }) => {
      const project = await getStoreProject(ctx.tenant, input.projectId)
      if (!project) throw new TRPCError({ code: 'NOT_FOUND', message: 'Store project not found.' })
      return project
    }),
  create: tenantProcedure(EDIT)
    .input(storeProjectCreateInputSchema)
    .mutation(({ ctx, input }) => createStoreProject(ctx.tenant, input)),
  updateDocument: tenantProcedure(EDIT)
    .input(storeProjectDocumentInputSchema)
    .mutation(({ ctx, input }) => updateStoreProjectDocument(ctx.tenant, input)),
  /** Remove the workspace copy; each browser keeps its own until it is deleted there. */
  delete: tenantProcedure(EDIT)
    .input(storeProjectRefInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!(await deleteStoreProject(ctx.tenant, input.projectId)))
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Store project not found.' })
      return { deleted: true }
    }),
})

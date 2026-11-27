import 'server-only'

import { TRPCError } from '@trpc/server'
import type { TenantAccessRequirement } from '@/lib/api/access-requirements'
import {
  projectCreateInputSchema,
  projectDocumentInputSchema,
  projectDuplicateInputSchema,
  projectListInputSchema,
  projectRecentSummaryInputSchema,
  projectRefInputSchema,
  projectRenameInputSchema,
  projectRestoreInputSchema,
  projectVersionCreateInputSchema,
  projectVersionRefInputSchema,
} from '@/lib/projects/schema'
import {
  createProject,
  createProjectVersion,
  deleteProject,
  duplicateProject,
  getProject,
  getProjectVersion,
  listProjects,
  listProjectVersions,
  listRecentWork,
  renameProject,
  restoreProjectVersion,
  updateProjectDocument,
} from '@/lib/tenant/projects'
import { router } from '../init'
import { tenantProcedure } from '../procedures'

const READ: TenantAccessRequirement = { apiKeyScope: 'artifact:read', permission: 'artifact:read' }
const EDIT: TenantAccessRequirement = { apiKeyScope: 'asset:write', permission: 'artifact:edit' }

function found<T>(value: T | null | false, what = 'Project'): T {
  if (!value) throw new TRPCError({ code: 'NOT_FOUND', message: `${what} not found.` })
  return value
}

/**
 * Cloud projects: the library, the open project's autosave, and its version
 * history. A document write based on an older revision fails with `CONFLICT`.
 */
export const projectRouter = router({
  recentSummary: tenantProcedure(READ)
    .input(projectRecentSummaryInputSchema)
    .query(({ ctx, input }) => listRecentWork(ctx.tenant, input.limit)),
  list: tenantProcedure(READ)
    .input(projectListInputSchema)
    .query(({ ctx, input }) => listProjects(ctx.tenant, input)),
  get: tenantProcedure(READ)
    .input(projectRefInputSchema)
    .query(async ({ ctx, input }) => found(await getProject(ctx.tenant, input.projectId))),
  create: tenantProcedure(EDIT)
    .input(projectCreateInputSchema)
    .mutation(({ ctx, input }) => createProject(ctx.tenant, input)),
  rename: tenantProcedure(EDIT)
    .input(projectRenameInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await renameProject(ctx.tenant, input.projectId, input.name))
    ),
  updateDocument: tenantProcedure(EDIT)
    .input(projectDocumentInputSchema)
    .mutation(({ ctx, input }) => updateProjectDocument(ctx.tenant, input.projectId, input)),
  duplicate: tenantProcedure(EDIT)
    .input(projectDuplicateInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await duplicateProject(ctx.tenant, input.projectId, input.name))
    ),
  delete: tenantProcedure(EDIT)
    .input(projectRefInputSchema)
    .mutation(async ({ ctx, input }) => {
      found(await deleteProject(ctx.tenant, input.projectId))
      return { deleted: true as const }
    }),
  versions: tenantProcedure(READ)
    .input(projectRefInputSchema)
    .query(async ({ ctx, input }) => found(await listProjectVersions(ctx.tenant, input.projectId))),
  version: tenantProcedure(READ)
    .input(projectVersionRefInputSchema)
    .query(async ({ ctx, input }) =>
      found(await getProjectVersion(ctx.tenant, input.projectId, input.versionId), 'Version')
    ),
  createVersion: tenantProcedure(EDIT)
    .input(projectVersionCreateInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await createProjectVersion(ctx.tenant, input.projectId, input.name))
    ),
  restoreVersion: tenantProcedure(EDIT)
    .input(projectRestoreInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(
        await restoreProjectVersion(
          ctx.tenant,
          input.projectId,
          input.versionId,
          input.baseRevision
        ),
        'Version'
      )
    ),
})

import 'server-only'

import { TRPCError } from '@trpc/server'
import type { TenantAccessRequirement } from '@/lib/api/access-requirements'
import {
  codeCampaignLinkInputSchema,
  codeCaptionInputSchema,
  codeImportInputSchema,
  codeProjectArchiveInputSchema,
  codeProjectCreateInputSchema,
  codeProjectDocumentInputSchema,
  codeProjectDuplicateInputSchema,
  codeProjectListInputSchema,
  codeProjectRefInputSchema,
  codeProjectRenameInputSchema,
} from '@/lib/code-studio/schema'
import {
  archiveCodeProject,
  createCodeProject,
  duplicateCodeProject,
  addCodeVisualToCampaign,
  getCodeProject,
  importCode,
  listCodeProjects,
  renameCodeProject,
  updateCodeProjectDocument,
} from '@/lib/tenant/code-projects'
import { codeCaptionUnavailable, writeCodeCaption } from '@/lib/write/code-caption'
import { router } from '../init'
import { organizationProcedure, tenantProcedure } from '../procedures'

const READ: TenantAccessRequirement = { apiKeyScope: 'artifact:read', permission: 'artifact:read' }
const EDIT: TenantAccessRequirement = { apiKeyScope: 'asset:write', permission: 'artifact:edit' }

function found<T>(value: T | null | false): T {
  if (!value) throw new TRPCError({ code: 'NOT_FOUND', message: 'Code project not found.' })
  return value
}

/**
 * Code Studio projects (RFC 053): the library and the open project's
 * autosave. A document write based on an older revision fails with `CONFLICT`.
 */
export const codeProjectRouter = router({
  list: tenantProcedure(READ)
    .input(codeProjectListInputSchema)
    .query(({ ctx, input }) => listCodeProjects(ctx.tenant, input)),
  get: tenantProcedure(READ)
    .input(codeProjectRefInputSchema)
    .query(async ({ ctx, input }) => found(await getCodeProject(ctx.tenant, input.projectId))),
  create: tenantProcedure(EDIT)
    .input(codeProjectCreateInputSchema)
    .mutation(({ ctx, input }) => createCodeProject(ctx.tenant, input)),
  rename: tenantProcedure(EDIT)
    .input(codeProjectRenameInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await renameCodeProject(ctx.tenant, input.projectId, input.name))
    ),
  updateDocument: tenantProcedure(EDIT)
    .input(codeProjectDocumentInputSchema)
    .mutation(({ ctx, input }) => updateCodeProjectDocument(ctx.tenant, input.projectId, input)),
  duplicate: tenantProcedure(EDIT)
    .input(codeProjectDuplicateInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await duplicateCodeProject(ctx.tenant, input.projectId, input.name))
    ),
  archive: tenantProcedure(EDIT)
    .input(codeProjectArchiveInputSchema)
    .mutation(async ({ ctx, input }) => {
      found(await archiveCodeProject(ctx.tenant, input.projectId, input.archived))
      return { archived: input.archived }
    }),
  /** Read a GitHub link a member pasted; the code is returned, never stored. */
  importLink: tenantProcedure(EDIT)
    .input(codeImportInputSchema)
    .mutation(({ ctx, input }) => importCode(ctx.tenant, input.url)),
  /** Link an exported code image to a campaign's visuals, for review with the rest. */
  addToCampaign: organizationProcedure('release:create')
    .input(codeCampaignLinkInputSchema)
    .mutation(({ ctx, input }) => addCodeVisualToCampaign(ctx.access, input)),
  /** Write a caption for a slide, charged to AI credits. */
  caption: organizationProcedure('artifact:edit')
    .input(codeCaptionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const reason = await codeCaptionUnavailable(ctx.access)
      if (reason) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: reason })
      return writeCodeCaption(ctx.access, input.document, input.slide)
    }),
})

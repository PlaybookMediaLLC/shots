import 'server-only'

import { TRPCError } from '@trpc/server'
import type { TenantAccessRequirement } from '@/lib/api/access-requirements'
import {
  creativeSetCreateInputSchema,
  creativeSetDocumentInputSchema,
  creativeSetDuplicateInputSchema,
  creativeSetListInputSchema,
  creativeSetLookupInputSchema,
  creativeSetIdSchema,
  creativeSetRefInputSchema,
  creativeSetRenameInputSchema,
  creativeSetRestoreInputSchema,
  creativeSetVersionCreateInputSchema,
  creativeSetVersionRefInputSchema,
  creativeSetHandoffSchema,
} from '@/lib/creative-sets/schema'
import {
  createCreativeSet,
  createCreativeSetCollabToken,
  createCreativeSetVersion,
  archiveCreativeSet,
  duplicateCreativeSet,
  getCreativeSet,
  getCreativeSetVersion,
  listCreativeSets,
  listCreativeSetVersions,
  renameCreativeSet,
  restoreCreativeSetVersion,
  updateCreativeSetDocument,
  attachCreativeSetDelivery,
} from '@/lib/tenant/creative-sets'
import { router } from '../init'
import { tenantProcedure } from '../procedures'
import { organizationProcedure } from '../procedures'
import { allowAiAction } from './launch'
import { withAiCredits } from '@/lib/ai/metering'
import { suggestCopy } from '@/lib/ai/store-screenshots/copy'
import { getWorkspaceVoice } from '@/lib/launch/store'
import {
  storyProposalRequestSchema,
  storyCopyProposalSchema,
  applyStoryProposal,
} from '@/lib/creative-sets/proposals'

const READ: TenantAccessRequirement = { apiKeyScope: 'artifact:read', permission: 'artifact:read' }
const EDIT: TenantAccessRequirement = { apiKeyScope: 'asset:write', permission: 'artifact:edit' }

function found<T>(value: T | null | false, what = 'Story Set'): T {
  if (!value) throw new TRPCError({ code: 'NOT_FOUND', message: `${what} not found.` })
  return value
}

/**
 * Cloud creativeSets: the library, the open creativeSet's autosave, and its version
 * history. A document write based on an older revision fails with `CONFLICT`.
 */
export const creativeSetRouter = router({
  collabToken: organizationProcedure('artifact:read')
    .input(creativeSetRefInputSchema)
    .mutation(({ ctx, input }) => createCreativeSetCollabToken(ctx.access, input.creativeSetId)),
  attachCampaign: organizationProcedure('release:create')
    .input(creativeSetHandoffSchema)
    .mutation(({ ctx, input }) => attachCreativeSetDelivery(ctx.access, input)),
  proposeCopy: organizationProcedure('artifact:edit')
    .input(storyProposalRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const set = found(await getCreativeSet(ctx.access, input.creativeSetId))
      if (set.revision !== input.baseRevision)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'The set changed. Save and request a new proposal.',
        })
      const story = set.document.stories.find((story) => story.id === input.storyId)
      const output = set.document.outputs.find(
        (output) => output.id === input.outputId && output.storyId === input.storyId
      )
      if (!story || !output)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Story or format not found.' })
      await allowAiAction(ctx.access)
      const voice = await getWorkspaceVoice(ctx.access)
      const result = await withAiCredits(ctx.access, () =>
        suggestCopy(
          {
            brief: input.facts,
            locale: 'en-US',
            tone: 'direct',
            length: 'short',
            count: 3,
            slides: [
              {
                id: story.id,
                topic: story.headline,
                currentHeadline: story.headline.slice(0, 200),
              },
            ],
          },
          voice
        )
      )
      const proposals = (
        result.slides.find((slide) => slide.id === story.id)?.suggestions ?? []
      ).map((item) =>
        storyCopyProposalSchema.parse({
          headline: item.headline,
          supporting: item.subheadline,
          reason: item.rationale,
        })
      )
      for (const proposal of proposals) applyStoryProposal(set.document, input, proposal)
      return { baseRevision: set.revision, proposals }
    }),
  list: tenantProcedure(READ)
    .input(creativeSetListInputSchema)
    .query(({ ctx, input }) => listCreativeSets(ctx.tenant, input)),
  get: tenantProcedure(READ)
    .input(creativeSetLookupInputSchema)
    .query(async ({ ctx, input }) => {
      if (!creativeSetIdSchema.safeParse(input.creativeSetId).success)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Story Set not found.' })
      return found(await getCreativeSet(ctx.tenant, input.creativeSetId))
    }),
  create: tenantProcedure(EDIT)
    .input(creativeSetCreateInputSchema)
    .mutation(({ ctx, input }) => createCreativeSet(ctx.tenant, input)),
  rename: tenantProcedure(EDIT)
    .input(creativeSetRenameInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await renameCreativeSet(ctx.tenant, input.creativeSetId, input.name))
    ),
  updateDocument: tenantProcedure(EDIT)
    .input(creativeSetDocumentInputSchema)
    .mutation(({ ctx, input }) =>
      updateCreativeSetDocument(ctx.tenant, input.creativeSetId, input)
    ),
  duplicate: tenantProcedure(EDIT)
    .input(creativeSetDuplicateInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(await duplicateCreativeSet(ctx.tenant, input.creativeSetId, input.name))
    ),
  archive: tenantProcedure(EDIT)
    .input(creativeSetRefInputSchema)
    .mutation(async ({ ctx, input }) => {
      found(await archiveCreativeSet(ctx.tenant, input.creativeSetId))
      return { archived: true as const }
    }),
  versions: tenantProcedure(READ)
    .input(creativeSetRefInputSchema)
    .query(async ({ ctx, input }) =>
      found(await listCreativeSetVersions(ctx.tenant, input.creativeSetId))
    ),
  version: tenantProcedure(READ)
    .input(creativeSetVersionRefInputSchema)
    .query(async ({ ctx, input }) =>
      found(
        await getCreativeSetVersion(ctx.tenant, input.creativeSetId, input.versionId),
        'Version'
      )
    ),
  createVersion: tenantProcedure(EDIT)
    .input(creativeSetVersionCreateInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(
        await createCreativeSetVersion(
          ctx.tenant,
          input.creativeSetId,
          input.name,
          input.baseRevision
        )
      )
    ),
  restoreVersion: tenantProcedure(EDIT)
    .input(creativeSetRestoreInputSchema)
    .mutation(async ({ ctx, input }) =>
      found(
        await restoreCreativeSetVersion(
          ctx.tenant,
          input.creativeSetId,
          input.versionId,
          input.baseRevision
        ),
        'Version'
      )
    ),
})

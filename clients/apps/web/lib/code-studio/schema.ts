import { z } from 'zod'
import {
  creativeSetIdSchema,
  creativeSetNameSchema,
  creativeSetRevisionSchema,
  creativeSetSortSchema,
} from '@/lib/creative-sets/schema'
import { codeDocumentSchema } from './document'

/**
 * The Code Studio API's inputs. A code project is stored as a creative set of
 * kind `code`, so ids, names and revisions follow the same rules.
 */

/** Input naming one code project. */
export const codeProjectRefInputSchema = z.object({ projectId: creativeSetIdSchema })

/** Input of `codeProject.list`. */
export const codeProjectListInputSchema = z.object({
  archived: z.boolean().optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(200).optional(),
  sort: creativeSetSortSchema.optional(),
})
/** One of {@link codeProjectListInputSchema}. */
export type CodeProjectListInput = z.infer<typeof codeProjectListInputSchema>

/** Input of `codeProject.create`; the client picks the id so a retried request cannot create two. */
export const codeProjectCreateInputSchema = z.object({
  id: creativeSetIdSchema,
  document: codeDocumentSchema,
  name: creativeSetNameSchema,
})

/** Input of `codeProject.rename`. */
export const codeProjectRenameInputSchema = codeProjectRefInputSchema.extend({
  name: creativeSetNameSchema,
})

/** Input of `codeProject.updateDocument`: a write based on the revision it started from. */
export const codeProjectDocumentInputSchema = codeProjectRefInputSchema.extend({
  baseRevision: creativeSetRevisionSchema,
  document: codeDocumentSchema,
})

/** Input of `codeProject.duplicate`. */
export const codeProjectDuplicateInputSchema = codeProjectRefInputSchema.extend({
  name: creativeSetNameSchema.optional(),
})

/** Archive a code project or return it to the library. */
export const codeProjectArchiveInputSchema = codeProjectRefInputSchema.extend({
  archived: z.boolean().default(true),
})

/** Input of `codeProject.importLink`: a GitHub file, pull request, commit or gist link. */
export const codeImportInputSchema = z.object({
  url: z.string().trim().url().max(2_000),
})

/** Input of `codeProject.caption`: the project and the slide to describe. */
export const codeCaptionInputSchema = z.object({
  document: codeDocumentSchema,
  slide: z.number().int().min(0).max(49),
})

/** Input of `codeProject.addToCampaign`: an exported image to link to a campaign's visuals. */
export const codeCampaignLinkInputSchema = z.object({
  assetId: z.uuid(),
  campaignId: z.string().cuid(),
  caption: z.string().trim().max(4_000).optional(),
})

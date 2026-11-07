import { z } from 'zod'
import { contentDraftCreateSchema } from '@/lib/api/contracts/content-drafts'
import { assetIdSchema } from './schemas'

/**
 * An edited campaign visual becoming a Publish draft. It lives beside
 * `schemas.ts` rather than in it because the draft contract imports that
 * module through the release contracts; importing it back there would be a
 * cycle, and the draft's shape must stay the composer's one source of truth.
 */
export const campaignPublishDraftSchema = z.object({
  campaignId: z.string().cuid(),
  /** The export saved by the editor, which the campaign also keeps. */
  assetId: assetIdSchema,
  /** The generated post the copy came from; the backend checks it is this campaign's. */
  campaignPostId: z.string().cuid().optional(),
  /** What the campaign's asset board shows beside the edited image. */
  caption: z.string().max(4_000).optional(),
  draft: contentDraftCreateSchema,
})

/** An edited campaign visual on its way to a Publish draft. */
export type CampaignPublishDraftInput = z.infer<typeof campaignPublishDraftSchema>

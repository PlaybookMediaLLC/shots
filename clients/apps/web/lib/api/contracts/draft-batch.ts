import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { BATCH_ITEM_LIMIT } from './content-batches'
import {
  contentDraftIdSchema,
  contentDraftParamsSchema,
  contentDraftScheduleSchema,
} from './content-drafts'

/** Preview queue or Spread times without creating scheduled posts. */
export const draftBatchTimesContract = defineContract({
  method: 'POST',
  name: 'content-drafts.batch-times',
  path: '/api/v1/content-draft-batch/times',
  body: z.object({
    socialSetId: contentDraftIdSchema,
    count: z.number().int().min(1).max(BATCH_ITEM_LIMIT),
    mode: z.enum(['queue', 'spread']),
    localTime: z.string().optional(),
    postsPerDay: z.number().int().min(1).max(24).optional(),
    spacingMinutes: z.number().int().min(1).max(1440).optional(),
    shiftMinutes: z.number().int().min(0).max(55).multipleOf(5).optional(),
    seed: z.string().min(16).max(128),
  }),
  output: z.object({ times: z.array(z.iso.datetime()).max(BATCH_ITEM_LIMIT) }),
  summary: 'Preview bulk scheduling times',
})

/** Session-only preflight; publishing permissions and approval apply. */
export const validateDraftScheduleContract = defineContract({
  method: 'POST',
  name: 'content-drafts.schedule-validate',
  path: '/api/v1/content-drafts/{id}/schedule/validate',
  params: contentDraftParamsSchema,
  body: contentDraftScheduleSchema,
  output: z.object({ valid: z.literal(true) }),
  summary: 'Check a draft schedule before committing a batch',
})

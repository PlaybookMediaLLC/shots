import { z } from 'zod'
import { draftKindSchema } from '@/lib/write/document'
import { contentDraftSortSchema, contentDraftViewSchema } from '@/lib/write/wire'

/** Where a draft is in its life. Scheduling sets `scheduled`. */
export const contentDraftStatusSchema = z.enum(['draft', 'scheduled', 'archived'])

/** A workspace resource id: a cuid or a UUID. */
export const contentDraftIdSchema = z
  .string()
  .regex(/^(?:[a-z0-9]{10,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)

/**
 * The list query. Without `status` or `view`, archived drafts are left out.
 * Pinned drafts come first, in `pinned`, on the first page.
 */
export const contentDraftListQuerySchema = z.object({
  /** A draft with a live post to this account, or, with none, meant for it. */
  connectionId: contentDraftIdSchema.optional(),
  cursor: z.string().max(500).optional(),
  /** From this instant, with `to` exclusive, on a live post's or a plan's time. */
  from: z.iso.datetime({ offset: true }).optional(),
  kind: draftKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().max(200).optional(),
  socialSetId: contentDraftIdSchema.optional(),
  sort: contentDraftSortSchema.optional(),
  status: contentDraftStatusSchema.optional(),
  tagId: contentDraftIdSchema.optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  view: contentDraftViewSchema.optional(),
})

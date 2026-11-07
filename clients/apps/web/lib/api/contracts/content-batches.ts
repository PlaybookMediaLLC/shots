import { z } from 'zod'
import { defineContract, timestampSchema } from '@/lib/api/contract'
import {
  BATCH_ITEM_LIMIT,
  BATCH_MEDIA_LIMIT,
  batchGridSchema,
  batchParamsSchema,
  batchRunSchema,
  fileNameSchema,
} from './content-batch-runs'
import {
  contentDraftCreateSchema,
  contentDraftIdSchema,
  contentDraftPostSchema,
  DRAFT_ACCOUNT_LIMIT,
} from './content-drafts'

/**
 * Bulk scheduling (RFC 042): a durable batch of separate posts. Each item
 * becomes its own draft and is scheduled through the ordinary draft schedule.
 */

export {
  BATCH_ITEM_LIMIT,
  BATCH_MEDIA_LIMIT,
  batchGridSchema,
  batchParamsSchema,
  batchRunSchema,
  GRID_HEADLINE_LIMIT,
  GRID_TOPIC_LIMIT,
  type BatchGrid,
  type BatchRun,
  type BatchRunItem,
} from './content-batch-runs'

/** One attachment of an item: an uploaded asset, or a selected file still uploading. */
export const batchMediaSchema = z
  .object({
    assetId: contentDraftIdSchema.optional(),
    /** The selected file's name and size, matched again when it must be reselected. */
    fileName: fileNameSchema.optional(),
    bytes: z.number().int().positive().optional(),
    /** The asset reserved for the file's upload once it starts. */
    uploadAssetId: contentDraftIdSchema.optional(),
  })
  .refine((media) => media.assetId || (media.fileName && media.bytes), {
    message: 'Each attachment is an uploaded asset or a selected file with its size.',
  })

/** One of {@link batchMediaSchema}. */
export type BatchMedia = z.infer<typeof batchMediaSchema>

/** When an item goes out: a local time in an IANA zone, or the queue at a previewed slot. */
export const batchTimingSchema = z.object({
  mode: z.enum(['time', 'queue']).optional(),
  localTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  timeZone: z.string().max(80).optional(),
  disambiguation: z.enum(['earlier', 'later']).optional(),
  expectedQueueSlot: z.iso.datetime().optional(),
})

/** One of {@link batchTimingSchema}. */
export type BatchTiming = z.infer<typeof batchTimingSchema>

/** A staged item; `importKey` makes a retry idempotent. */
export const batchItemInputSchema = z.object({
  importKey: z.string().min(16).max(128),
  caption: z.string().max(100_000),
  media: z.array(batchMediaSchema).max(BATCH_MEDIA_LIMIT),
  channelConnectionIds: z.array(contentDraftIdSchema).max(DRAFT_ACCOUNT_LIMIT),
  /** A grid video concept; its rendered video becomes the item's media. */
  grid: batchGridSchema.optional(),
  /** The file or folder name the item came from; caption CSVs match on it. */
  sourceKey: z.string().max(255).optional(),
  timing: batchTimingSchema,
})

/** One of {@link batchItemInputSchema}. */
export type BatchItemInput = z.infer<typeof batchItemInputSchema>

/** An attachment and what its asset holds now. */
const batchMediaViewSchema = z.object({
  assetId: z.string().optional(),
  fileName: z.string().optional(),
  bytes: z.number().int().optional(),
  uploadAssetId: z.string().optional(),
  durationMs: z.number().int().nullable(),
  height: z.number().int().nullable(),
  mediaType: z.string().optional(),
  /** UPLOADED, PENDING, FAILED, DELETED, missing, or local (not uploading yet). */
  status: z.string(),
  width: z.number().int().nullable(),
})

/** An item with its media, its draft and that draft's scheduled posts. */
export const batchItemSchema = z.object({
  caption: z.string(),
  channelConnectionIds: z.array(z.string()),
  draft: z
    .object({
      approvedVersion: z.number().int().nullable(),
      assetIds: z.array(z.string()),
      channelConnectionIds: z.array(z.string()),
      plainText: z.string(),
      reviewStatus: z.string(),
      status: z.string(),
      title: z.string(),
      version: z.number().int(),
    })
    .nullable(),
  draftId: z.string().nullable(),
  grid: batchGridSchema.nullish(),
  id: z.string(),
  importKey: z.string(),
  media: z.array(batchMediaViewSchema),
  position: z.number().int(),
  posts: z.array(contentDraftPostSchema),
  sourceKey: z.string().optional(),
  timing: batchTimingSchema,
})

/** One of {@link batchItemSchema}. */
export type BatchItem = z.infer<typeof batchItemSchema>

/** A batch; `items` is present when one batch is read. */
export const contentBatchSchema = z.object({
  archivedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  id: z.string(),
  itemCount: z.number().int(),
  items: z.array(batchItemSchema).optional(),
  /** The latest render of this batch, when one batch is read. */
  render: batchRunSchema.optional(),
  socialSetId: z.string(),
  /** The latest schedule of this batch, when one batch is read. */
  submission: batchRunSchema.optional(),
  timeZone: z.string(),
  title: z.string(),
  updatedAt: timestampSchema,
})

/** One of {@link contentBatchSchema}. */
export type ContentBatch = z.infer<typeof contentBatchSchema>

/** Path parameters of a batch item. */
export const batchItemParamsSchema = z.object({
  id: contentDraftIdSchema,
  itemId: contentDraftIdSchema,
})

/** `GET /api/v1/content-batches` */
export const listContentBatchesContract = defineContract({
  method: 'GET',
  name: 'content-batches.list',
  output: z.object({ batches: z.array(contentBatchSchema) }),
  path: '/api/v1/content-batches',
  summary: 'List open bulk batches',
})

/** `POST /api/v1/content-batches` */
export const createContentBatchContract = defineContract({
  body: z.object({
    socialSetId: contentDraftIdSchema.optional(),
    title: z.string().min(1).max(200),
  }),
  method: 'POST',
  name: 'content-batches.create',
  output: contentBatchSchema,
  path: '/api/v1/content-batches',
  status: 201,
  summary: 'Start a bulk batch',
})

/** `GET /api/v1/content-batches/{id}` */
export const getContentBatchContract = defineContract({
  method: 'GET',
  name: 'content-batches.get',
  output: contentBatchSchema,
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}',
  summary: 'Read a bulk batch with its items',
})

/** `POST /api/v1/content-batches/{id}/archive` */
export const archiveContentBatchContract = defineContract({
  method: 'POST',
  name: 'content-batches.archive',
  output: z.object({ archived: z.literal(true) }),
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/archive',
  summary: 'Close a bulk batch',
})

/** `POST /api/v1/content-batches/{id}/items` */
export const addContentBatchItemsContract = defineContract({
  body: z.object({ items: z.array(batchItemInputSchema).min(1).max(BATCH_ITEM_LIMIT) }),
  method: 'POST',
  name: 'content-batches.items.add',
  output: contentBatchSchema,
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/items',
  summary: 'Stage items in a bulk batch',
})

/** What a batch item update may change. */
const batchItemUpdateSchema = batchItemInputSchema
  .pick({ caption: true, channelConnectionIds: true, grid: true, media: true, timing: true })
  .partial()
  .extend({
    position: z
      .number()
      .int()
      .min(0)
      .max(10 * BATCH_ITEM_LIMIT)
      .optional(),
  })

/** `PATCH /api/v1/content-batches/{id}/items`: every change applies, or none does. */
export const updateContentBatchItemsContract = defineContract({
  body: z.object({
    items: z
      .array(batchItemUpdateSchema.extend({ itemId: contentDraftIdSchema }))
      .min(1)
      .max(BATCH_ITEM_LIMIT),
  }),
  method: 'PATCH',
  name: 'content-batches.items.update-many',
  output: contentBatchSchema,
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/items',
  summary: 'Change many bulk batch items at once',
})

/** `PATCH /api/v1/content-batches/{id}/items/{itemId}` */
export const updateContentBatchItemContract = defineContract({
  body: batchItemUpdateSchema,
  method: 'PATCH',
  name: 'content-batches.items.update',
  output: batchItemSchema,
  params: batchItemParamsSchema,
  path: '/api/v1/content-batches/{id}/items/{itemId}',
  summary: 'Change a bulk batch item',
})

/** `DELETE /api/v1/content-batches/{id}/items/{itemId}` */
export const removeContentBatchItemContract = defineContract({
  method: 'DELETE',
  name: 'content-batches.items.remove',
  output: z.object({ removed: z.literal(true) }),
  params: batchItemParamsSchema,
  path: '/api/v1/content-batches/{id}/items/{itemId}',
  summary: 'Remove a bulk batch item',
})

/** `POST /api/v1/content-batches/{id}/items/{itemId}/draft` */
export const createContentBatchItemDraftContract = defineContract({
  body: contentDraftCreateSchema.omit({ importKey: true, socialSetId: true, requestKey: true }),
  method: 'POST',
  name: 'content-batches.items.draft',
  output: batchItemSchema,
  params: batchItemParamsSchema,
  path: '/api/v1/content-batches/{id}/items/{itemId}/draft',
  summary: 'Save a bulk batch item as its draft',
})

/** One item and account: whether it can be scheduled now, and what to fix. */
export const batchValidationSchema = z.object({
  channelConnectionId: z.string(),
  error: z.string().optional(),
  itemId: z.string(),
  scheduledFor: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string(),
  valid: z.boolean(),
})

/** One of {@link batchValidationSchema}. */
export type BatchValidation = z.infer<typeof batchValidationSchema>

/** `POST /api/v1/content-batches/{id}/validate` */
export const validateContentBatchContract = defineContract({
  body: z.object({
    items: z
      .array(
        z.object({
          itemId: contentDraftIdSchema,
          channelConnectionIds: z.array(contentDraftIdSchema).min(1).max(DRAFT_ACCOUNT_LIMIT),
        })
      )
      .min(1)
      .max(BATCH_ITEM_LIMIT),
  }),
  method: 'POST',
  name: 'content-batches.validate',
  output: z.object({ results: z.array(batchValidationSchema) }),
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/validate',
  summary: 'Check each batch item and account before scheduling',
})

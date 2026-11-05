import { z } from 'zod'
import { defineContract, timestampSchema } from '@/lib/api/contract'
import { contentDraftIdSchema } from './content-drafts'

/**
 * Runs of a bulk batch: a schedule that carries on without the browser, and a
 * render that freezes grid concepts while a browser makes their videos. The
 * shapes a batch shares with its runs live here too, so neither imports the other.
 */

/** The most posts one batch holds; Go's `contentBatchItemLimit`. */
export const BATCH_ITEM_LIMIT = 100

/** The most attachments one post holds; Go's `contentDraftAssetLimit`. */
export const BATCH_MEDIA_LIMIT = 20

/** A file name as stored in an object key: letters, digits, dots, dashes, underscores. */
export const fileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/)
  .refine((value) => value !== '.' && value !== '..')

/** The most characters of a grid video's headline; Go's `batchGridHeadlineLimit`. */
export const GRID_HEADLINE_LIMIT = 60

/** The most characters of a grid cell's label; Go's `batchGridTopicLimit`. */
export const GRID_TOPIC_LIMIT = 100

/** A 2x2 grid video concept: a headline above four labelled images, with optional music. */
export const batchGridSchema = z.object({
  headline: z.string().trim().min(1).max(GRID_HEADLINE_LIMIT),
  musicAssetId: contentDraftIdSchema.optional(),
  slots: z
    .array(
      z.object({
        assetId: contentDraftIdSchema.optional(),
        topic: z.string().max(GRID_TOPIC_LIMIT),
      })
    )
    .length(4),
})

/** One of {@link batchGridSchema}. */
export type BatchGrid = z.infer<typeof batchGridSchema>

/** One item of a run: what was frozen for it and what happened. */
export const batchRunItemSchema = z.object({
  assetId: z.string().optional(),
  draftId: z.string().optional(),
  error: z.string().optional(),
  grid: batchGridSchema.optional(),
  itemId: z.string(),
  postIds: z.array(z.string()).optional(),
  status: z.enum(['PENDING', 'DONE', 'FAILED', 'UNCONFIRMED']),
})

/** One of {@link batchRunItemSchema}. */
export type BatchRunItem = z.infer<typeof batchRunItemSchema>

/** One pass over a batch: scheduling its items, or rendering its grid concepts. */
export const batchRunSchema = z.object({
  createdAt: timestampSchema,
  id: z.string(),
  items: z.array(batchRunItemSchema),
  kind: z.enum(['submit', 'render']),
  status: z.enum(['RUNNING', 'FINISHED', 'SUPERSEDED']),
  updatedAt: timestampSchema,
})

/** One of {@link batchRunSchema}. */
export type BatchRun = z.infer<typeof batchRunSchema>

/** Path parameters of a batch. */
export const batchParamsSchema = z.object({ id: contentDraftIdSchema })

/** A retry key: the same key replays its run instead of making another. */
const requestKeySchema = z.string().min(16).max(128)

/** Path parameters of a batch's run. */
export const batchRunParamsSchema = z.object({
  id: contentDraftIdSchema,
  runId: contentDraftIdSchema,
})

/** `POST /api/v1/content-batches/{id}/submit`: the schedule carries on without the browser. */
export const submitContentBatchContract = defineContract({
  body: z.object({
    items: z
      .array(
        z.object({
          itemId: contentDraftIdSchema,
          channelConnectionIds: z.array(contentDraftIdSchema).min(1).max(10),
        })
      )
      .min(1)
      .max(BATCH_ITEM_LIMIT),
    requestKey: requestKeySchema,
  }),
  method: 'POST',
  name: 'content-batches.submit',
  output: batchRunSchema,
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/submit',
  summary: 'Schedule a bulk batch in the background',
})

/** `GET /api/v1/content-batches/{id}/runs/{runId}` */
export const getContentBatchRunContract = defineContract({
  method: 'GET',
  name: 'content-batches.runs.get',
  output: batchRunSchema,
  params: batchRunParamsSchema,
  path: '/api/v1/content-batches/{id}/runs/{runId}',
  summary: 'Read what a schedule or render of a bulk batch did',
})

/** `POST /api/v1/content-batches/{id}/renders`: freeze concepts for this browser to render. */
export const createContentBatchRenderContract = defineContract({
  body: z.object({
    itemIds: z.array(contentDraftIdSchema).min(1).max(BATCH_ITEM_LIMIT),
    requestKey: requestKeySchema,
  }),
  method: 'POST',
  name: 'content-batches.renders.create',
  output: batchRunSchema,
  params: batchParamsSchema,
  path: '/api/v1/content-batches/{id}/renders',
  summary: 'Freeze grid videos for rendering',
})

/** `POST /api/v1/content-batches/{id}/renders/{runId}/items/{itemId}` */
export const reportContentBatchRenderContract = defineContract({
  body: z
    .object({
      assetId: contentDraftIdSchema.optional(),
      error: z.string().min(1).max(2000).optional(),
      fileName: fileNameSchema.optional(),
    })
    .refine((report) => Boolean(report.assetId) !== Boolean(report.error), {
      message: 'Report a video or why it could not be made.',
    }),
  method: 'POST',
  name: 'content-batches.renders.report',
  output: batchRunSchema,
  params: batchRunParamsSchema.extend({ itemId: contentDraftIdSchema }),
  path: '/api/v1/content-batches/{id}/renders/{runId}/items/{itemId}',
  summary: 'Record a rendered grid video, or why it failed',
})

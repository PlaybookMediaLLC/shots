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

/** The most characters of a UGC video's overlay text; Go's `batchUGCTextLimit`. */
export const UGC_TEXT_LIMIT = 150

/** The latest a template's music may start; Go's `batchMusicStartLimit`. */
export const MUSIC_START_LIMIT_MS = 10 * 60 * 1000

/** Clip lengths a UGC video takes, to the tenth of a second; Go's `checkBatchGrid`. */
export const UGC_CLIP_MS = { max: 60_000, min: 3_000 } as const

/** Lengths of the clip shown after a UGC video. */
export const UGC_CLOSING_MS = { max: 15_000, min: 3_000 } as const

/** Where a UGC video's text sits. */
export const overlayPositionSchema = z.enum(['top', 'middle', 'bottom'])

/** Where a UGC video's text sits. */
export type OverlayPosition = z.infer<typeof overlayPositionSchema>

/** How many slots and characters of text each template takes; a grid is the default. */
export const TEMPLATE_SHAPES = {
  grid: { slots: 4, text: GRID_HEADLINE_LIMIT },
  single: { slots: 1, text: GRID_HEADLINE_LIMIT },
  ugc: { slots: 1, text: UGC_TEXT_LIMIT },
} as const

/**
 * A template video concept. Without `kind` it is the 2x2 grid: a headline above
 * four labelled images. `single` fades one image in under a headline, which
 * `hideHeadline` leaves out while keeping it; `ugc` writes its text over the
 * workspace's own clip, in its one slot, with an optional closing clip after.
 * Music is optional and plays from `musicStartMs`.
 */
const conceptSchema = z.object({
  closingAssetId: contentDraftIdSchema.optional(),
  // Counted in code points below, as Go counts runes; this only bounds parsing.
  headline: z
    .string()
    .trim()
    .max(UGC_TEXT_LIMIT * 4),
  hideHeadline: z.boolean().optional(),
  kind: z.enum(['single', 'ugc']).optional(),
  musicAssetId: contentDraftIdSchema.optional(),
  musicStartMs: z.number().int().min(0).max(MUSIC_START_LIMIT_MS).optional(),
  slots: z
    .array(
      z.object({
        assetId: contentDraftIdSchema.optional(),
        topic: z.string().max(GRID_TOPIC_LIMIT),
      })
    )
    .min(1)
    .max(4),
  textPosition: overlayPositionSchema.optional(),
})

type ConceptFields = z.infer<typeof conceptSchema>

/** Fields of other templates, which Go refuses on this one. */
const FOREIGN_FIELDS = {
  grid: ['hideHeadline', 'textPosition', 'closingAssetId'],
  single: ['textPosition', 'closingAssetId'],
  ugc: ['hideHeadline'],
} as const

/** A concept's slots and text against its kind's shape: [field, message] pairs, as Go refuses them. */
function shapeIssues(grid: ConceptFields): [string, string][] {
  const kind = grid.kind ?? 'grid'
  const shape = TEMPLATE_SHAPES[kind]
  const noun = kind === 'ugc' ? 'clip' : shape.slots === 1 ? 'image' : 'images'
  // Counted in code points, as Go counts runes.
  const length = [...grid.headline].length
  return [
    ...(grid.slots.length === shape.slots
      ? []
      : [['slots', `This video takes ${shape.slots} ${noun}.`] as [string, string]]),
    ...(length > shape.text || (!length && !grid.hideHeadline)
      ? [['headline', `A video needs text of 1 to ${shape.text} characters.`] as [string, string]]
      : []),
  ]
}

/** Fields that belong to another kind, and a music start without music. */
function fieldIssues(grid: ConceptFields): [string, string][] {
  const foreign = FOREIGN_FIELDS[grid.kind ?? 'grid'].filter((field) => grid[field])
  return [
    ...foreign.map((field): [string, string] => [field, `This video has no ${field}.`]),
    ...(grid.musicStartMs && !grid.musicAssetId
      ? [['musicStartMs', 'Music starts only with music.'] as [string, string]]
      : []),
  ]
}

/** {@link conceptSchema} as the API takes it, checked per kind as Go checks it. */
export const batchGridSchema = conceptSchema.superRefine((grid, context) => {
  for (const [path, message] of [...shapeIssues(grid), ...fieldIssues(grid)])
    context.addIssue({ code: 'custom', message, path: [path] })
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

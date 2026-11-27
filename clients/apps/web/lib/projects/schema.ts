import { z } from 'zod'

/**
 * Shared shapes for cloud projects: the tRPC inputs the server validates and
 * the closed sets the editor and library switch on.
 */

/** How a project version came to be. Autosaves are pruned; the rest are kept. */
export const projectVersionKindSchema = z.enum(['autosave', 'named', 'restore', 'duplicate'])
/** One of {@link projectVersionKindSchema}. */
export type ProjectVersionKind = z.infer<typeof projectVersionKindSchema>

/** Library order: last edited first, or by name. */
export const projectSortSchema = z.enum(['updated', 'name'])
/** One of {@link projectSortSchema}. */
export type ProjectSort = z.infer<typeof projectSortSchema>

/**
 * Where the open project's autosave is. `offline` keeps changes on this
 * device and retries; `error` is a save the server refused for good.
 */
export const projectSaveStatusSchema = z.enum([
  'loading',
  'saved',
  'unsaved',
  'saving',
  'offline',
  'conflict',
  'error',
])
/** One of {@link projectSaveStatusSchema}. */
export type ProjectSaveStatus = z.infer<typeof projectSaveStatusSchema>

/** A project or version id (the backend issues cuids). */
export const projectIdSchema = z.string().cuid()

/** A project name, as the backend accepts it. */
export const projectNameSchema = z.string().trim().min(1, 'Enter a name.').max(200)

/** A version name, as the backend accepts it. */
export const projectVersionNameSchema = z.string().trim().min(1, 'Enter a name.').max(120)

/** A project revision; every document write names the one it was based on. */
export const projectRevisionSchema = z.number().int().min(1)

/** Input of `project.list`. */
export const projectListInputSchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(200).optional(),
  sort: projectSortSchema.optional(),
})
/** One of {@link projectListInputSchema}. */
export type ProjectListInput = z.infer<typeof projectListInputSchema>

/** Input of `project.recentSummary` (lightweight sidebar recents). */
export const projectRecentSummaryInputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
})
/** One of {@link projectRecentSummaryInputSchema}. */
export type ProjectRecentSummaryInput = z.infer<typeof projectRecentSummaryInputSchema>

/** Input of `project.create`. The document is checked by `parseDesignDocument`. */
export const projectCreateInputSchema = z.object({
  document: z.unknown(),
  name: projectNameSchema,
})

/** Input naming one project. */
export const projectRefInputSchema = z.object({ projectId: projectIdSchema })

/** Input of `project.rename`. */
export const projectRenameInputSchema = projectRefInputSchema.extend({ name: projectNameSchema })

/** Input of `project.updateDocument`. */
export const projectDocumentInputSchema = projectRefInputSchema.extend({
  baseRevision: projectRevisionSchema,
  document: z.unknown(),
})

/** Input of `project.duplicate`. */
export const projectDuplicateInputSchema = projectRefInputSchema.extend({
  name: projectNameSchema.optional(),
})

/** Input naming one version of a project. */
export const projectVersionRefInputSchema = projectRefInputSchema.extend({
  versionId: projectIdSchema,
})

/** Input of `project.createVersion`. */
export const projectVersionCreateInputSchema = projectRefInputSchema.extend({
  name: projectVersionNameSchema,
})

/** Input of `project.restoreVersion`. */
export const projectRestoreInputSchema = projectVersionRefInputSchema.extend({
  baseRevision: projectRevisionSchema,
})

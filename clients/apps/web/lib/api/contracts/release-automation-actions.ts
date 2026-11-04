import { z } from 'zod'

/**
 * The release-automation actions a workflow node can hold, kept apart from
 * the rest of the workflow contract so each file stays readable.
 */

/** Action identifiers the Go executor registers. Approval and publishing are not actions. */
export const automationActionTypeSchema = z.enum([
  'create_release',
  'create_campaign',
  'generate_copy',
  'render_creatives',
  'render_code_visual',
  'create_canvas',
  'submit_review',
])

/** A reference to an output recorded by an earlier action on every path. */
export const automationReferenceSchema = z.object({
  nodeId: z.string().max(64),
  output: z.string().max(64),
})

/**
 * One action's configuration, discriminated by type. Drafts may be
 * incomplete, so fields are optional here; the Go validator decides whether
 * a configuration is executable.
 */
export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_release'),
    audience: z.string().max(1000).optional(),
    include: z.enum(['unreleased']).optional(),
  }),
  z.object({
    type: z.literal('create_campaign'),
    input: automationReferenceSchema.optional(),
    brandKitId: z.string().max(64).optional(),
    destinationIds: z.array(z.string().max(64)).max(10).optional(),
    audience: z.string().max(1000).optional(),
    callToAction: z.string().max(300).optional(),
  }),
  z.object({
    type: z.literal('generate_copy'),
    input: automationReferenceSchema.optional(),
    creditLimit: z.number().int().min(0).max(500).optional(),
  }),
  z.object({
    type: z.literal('render_creatives'),
    input: automationReferenceSchema.optional(),
    templateIds: z.array(z.string().max(64)).max(3).optional(),
    surfaceId: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('render_code_visual'),
    input: automationReferenceSchema.optional(),
    /** The owner's consent to read the merged pull request's diff. */
    readSourceCode: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('create_canvas'),
    input: automationReferenceSchema.optional(),
    recipeIds: z.array(z.string().max(64)).max(3).optional(),
    surfaceId: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('submit_review'),
    input: automationReferenceSchema.optional(),
  }),
])

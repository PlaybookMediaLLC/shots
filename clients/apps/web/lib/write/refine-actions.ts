import { z } from 'zod'
import { draftChannelSchema } from '@/lib/write/document'

/**
 * AI Refine and the writing assistant (RFC 025), shared by the composer and
 * the routes. Refine works on an explicit scope (a selection, one post, or
 * every post of the version open) and answers one text per text sent; the
 * composer previews it and applies it only when accepted.
 */

/** What Refine can do. `custom` follows the writer's own instruction. */
export const refineActionSchema = z.enum([
  'fix-grammar',
  'improve',
  'punchier',
  'condense',
  'rephrase',
  'mix-it-up',
  'expand',
  'continue',
  'structure',
  'positive',
  'thread-start',
  'emoji',
  'announcement',
  'custom',
  'title',
])

/** One of {@link refineActionSchema}. */
export type RefineAction = z.infer<typeof refineActionSchema>

/** The actions as the Refine menu lists them, in order; `title` is the properties panel's. */
export const REFINE_LABELS: Record<Exclude<RefineAction, 'title'>, string> = {
  'fix-grammar': 'Fix grammar',
  improve: 'Improve writing',
  punchier: 'Make it punchier',
  condense: 'Condense',
  rephrase: 'Rephrase',
  'mix-it-up': 'Mix it up',
  expand: 'Expand and elaborate',
  continue: 'Continue writing',
  structure: 'Improve structure and spacing',
  positive: 'Rewrite in a positive tone',
  'thread-start': 'Rewrite as a thread start',
  emoji: 'Add emoji',
  announcement: 'Rewrite as an announcement',
  custom: 'Follow my instruction',
}

/** What Refine works on. */
export const refineScopeSchema = z.enum(['selection', 'post', 'draft'])

/** One of {@link refineScopeSchema}. */
export type RefineScope = z.infer<typeof refineScopeSchema>

/** A Refine request: the texts in scope, for a platform and its limit. */
export const refineInputSchema = z.strictObject({
  action: refineActionSchema,
  channel: draftChannelSchema,
  /** Each text's limit, as the platform counts it for this account. */
  limit: z.number().int().min(1).max(100_000),
  /** The writer's instruction, for `custom`. */
  prompt: z.string().trim().max(1_000).optional(),
  /** The draft, whose set's writing context (RFC 024) guides the writing. */
  draftId: z.string().max(40).optional(),
  scope: refineScopeSchema,
  texts: z.array(z.string().max(100_000)).min(1).max(25),
})

/** One of {@link refineInputSchema}. */
export type RefineInput = z.infer<typeof refineInputSchema>

/** A turn of the writing assistant's conversation. */
export const assistantMessageSchema = z.strictObject({
  content: z.string().trim().min(1).max(8_000),
  role: z.enum(['user', 'assistant']),
})

/** A writing assistant request: the conversation and the draft it is about. */
export const assistantInputSchema = z.strictObject({
  channel: draftChannelSchema,
  /** The draft's posts as the platform would read them. */
  draft: z.array(z.string().max(100_000)).max(25),
  /** The draft, whose set's writing context (RFC 024) guides the writing. */
  draftId: z.string().max(40).optional(),
  messages: z.array(assistantMessageSchema).min(1).max(30),
})

/** One of {@link assistantInputSchema}. */
export type AssistantInput = z.infer<typeof assistantInputSchema>

/** The tags this module fences content with. */
const FENCE_TAGS =
  /<\/?\s*(?:text|sample|voice|audience|instruction|draft|post|platform|writing_context)\b[^>]*>/gi

/**
 * Content for a fence: any of the fence tags inside it are removed, so text
 * the writer or a sample supplies cannot close its fence and pose as
 * instructions.
 */
export function fenced(content: string): string {
  return content.replace(FENCE_TAGS, '')
}

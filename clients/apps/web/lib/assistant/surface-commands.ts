import { z } from 'zod'
import { canvasCommandSchema } from '@/lib/canvas/commands'
import { codeCommandSchema } from '@/lib/code-studio/commands'
import { setCommandSchema } from '@/lib/creative-sets/commands'

/**
 * The surfaces that edit through typed commands: what the model may send, and
 * the browser parses with the same schema. None of them can delete work.
 */

type Union = z.ZodDiscriminatedUnion<z.ZodObject<{ type: z.ZodLiteral<string> }>[]>

/** The named members of a command union. */
function only<T extends Union>(schema: T, types: readonly string[]): T {
  const options = (schema as Union).options.filter((option) =>
    types.includes(option.shape.type.value)
  )
  return z.discriminatedUnion('type', options as Union['options'] & [Union['options'][number]]) as never
}

const edit = <T extends z.ZodType>(command: T) =>
  z.object({
    commands: z.array(command).min(1).max(20),
    summary: z.string().trim().min(1).max(160),
  })

export const boardEditSchema = edit(
  only(canvasCommandSchema as never, [
    'move-artboards',
    'rename-artboard',
    'duplicate-artboards',
    'stack-artboards',
    'resize-artboard',
  ])
)

export const storySetEditSchema = edit(
  only(setCommandSchema as never, [
    'story-copy',
    'output-copy',
    'reset-copy',
    'promote-copy',
    'focus',
    'reorder-stories',
    'layout',
  ])
)

export const codeSceneEditSchema = edit(codeCommandSchema)

/** The tweet image's styling. */
export const tweetEditSchema = edit(
  z.object({
    type: z.literal('style'),
    theme: z.enum(['light', 'dark']).optional(),
    showBackground: z.boolean().optional(),
    padding: z.union([z.literal(16), z.literal(32), z.literal(64), z.literal(128)]).optional(),
  })
)

/** A suggestion for the open draft; the person decides whether it goes in. */
export const draftProposalSchema = z.object({
  mode: z
    .enum(['new-post', 'replace-selection'])
    .describe('replace-selection only when the page context names selected text.'),
  summary: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(3_000),
})

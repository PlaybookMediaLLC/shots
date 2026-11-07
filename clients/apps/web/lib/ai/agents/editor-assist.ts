import 'server-only'

import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { describeWholeCatalog } from '@/lib/design/catalog-sections'
import {
  type DesignChanges,
  type DesignDocument,
  definedChanges,
  designChangesSchema,
  patchDesignDocument,
} from '@/lib/design/document'
import { models } from '../models'
import { tokenCostUsd, settleCredits } from '../metering/pricing'
import { EDITOR_CRITIC_INSTRUCTIONS, EDITOR_VARIANTS_INSTRUCTIONS } from '../prompts/editor-copilot'
import { distinctnessProblem } from '../variants'

/**
 * One-shot editor assistants: the critic (one-click improvement chips) and
 * the variants generator (complete versions to compare).
 *
 * Proposals arrive as tool calls rather than structured output. The change
 * schema is far richer than the optional-field limits providers put on
 * constrained JSON; tool arguments are validated here instead, and an invalid
 * proposal is reported back so the model can correct it in the same run.
 * Every accepted proposal patches the current document into a valid one, so
 * applying it can never produce a design the editor cannot load.
 */

type Proposal = { changes: DesignChanges; reason: string; title: string }

function designContext(document: DesignDocument): string {
  return `<catalog>${describeWholeCatalog()}</catalog>\n<design>${JSON.stringify(document)}</design>`
}

/** Changes that patch the current document into a valid one, or null. */
function applicable(document: DesignDocument, changes: unknown): DesignChanges | null {
  try {
    const cleaned = definedChanges(designChangesSchema.parse(changes)) as DesignChanges
    patchDesignDocument(document, cleaned)
    return cleaned
  } catch {
    return null
  }
}

function proposalTool(
  description: string,
  document: DesignDocument,
  limit: number,
  proposals: Proposal[]
) {
  return tool({
    description,
    execute: async (input: { changes: unknown; reason: string; title: string }) => {
      if (proposals.length >= limit) return { error: 'Enough proposals already.', ok: false }
      const changes = applicable(document, input.changes)
      if (!changes) {
        return {
          error: 'Those changes do not produce a valid design. Check option ids and units.',
          ok: false,
        }
      }
      proposals.push({ changes, reason: input.reason, title: input.title })
      return { ok: true }
    },
    inputSchema: z.object({
      changes: designChangesSchema,
      reason: z.string().max(200).describe('One sentence on why.'),
      title: z.string().max(60).describe('A short name for the proposal.'),
    }),
  })
}

export async function critiqueDesign(document: DesignDocument, snapshotJpegBase64: string | null) {
  const suggestions: Proposal[] = []
  await generateText({
    messages: [
      {
        content: [
          { text: designContext(document), type: 'text' },
          ...(snapshotJpegBase64
            ? [{ data: snapshotJpegBase64, mediaType: 'image/jpeg', type: 'file' as const }]
            : []),
        ],
        role: 'user',
      },
    ],
    model: models.languageModel('fast'),
    abortSignal: AbortSignal.timeout(15_000),
    maxOutputTokens: 2400,
    stopWhen: [stepCountIs(2), () => suggestions.length > 0],
    system: `${EDITOR_CRITIC_INSTRUCTIONS}\n\nCall proposeSuggestion once per suggestion (at most three), then stop. If nothing needs fixing, call nothing.`,
    tools: {
      proposeSuggestion: proposalTool(
        'Propose one improvement with the exact changes to apply.',
        document,
        3,
        suggestions
      ),
    },
  })
  return suggestions
}

/** One proposed version: its name, why it differs, and the changes that make it from the current design. */
export type Variant = Proposal

/**
 * The brand a design must stay within, as the brand kit defines it. Versions
 * explore composition, frame and typography scale; they do not invent a new
 * palette or typeface for a workspace that has one.
 */
export type VariantBrand = {
  accent: string
  background: string
  bodyFont: string | null
  foreground: string
  headingFont: string | null
  name: string
  palette: readonly string[]
  secondary?: string
}

/** The brand constraint as the model reads it. */
function brandConstraint(brand: VariantBrand): string {
  const colors = [brand.background, brand.foreground, brand.accent, brand.secondary, ...brand.palette]
    .filter((color): color is string => Boolean(color))
    .join(', ')
  const fonts = [brand.headingFont, brand.bodyFont].filter(Boolean).join(' for headlines, ')
  return [
    `\n\nEvery version must stay on the \u201c${brand.name}\u201d brand.`,
    `Use only these colours: ${colors}.`,
    fonts ? `Use these font ids: ${fonts}.` : '',
    'Explore layout, frame, perspective and type scale instead of new colours or typefaces.',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Propose `count` complete versions of a design for the user to compare.
 * Each must change the composition, not only its colours (unless asked),
 * and differ from the others; a proposal that does not is sent back to the
 * model with the reason. The browser patches its own copy of the design with
 * each version's changes and renders it, so local images never leave it.
 */
export async function proposeVariants(
  document: DesignDocument,
  options: { brand?: VariantBrand | null; count: number; instruction?: string }
): Promise<Variant[]> {
  const variants: Variant[] = []
  await generateText({
    messages: [
      {
        content: `${designContext(document)}\n\nPropose ${options.count} versions.${
          options.instruction ? ` The user asked: ${options.instruction}` : ''
        }${options.brand ? brandConstraint(options.brand) : ''}`,
        role: 'user',
      },
    ],
    model: models.languageModel('deep'),
    stopWhen: stepCountIs(options.count + 4),
    system: `${EDITOR_VARIANTS_INSTRUCTIONS}\n\nCall proposeVariant once per version, then stop.`,
    tools: {
      proposeVariant: tool({
        description: 'Propose one complete version with the exact changes that produce it.',
        execute: async (input: { changes: unknown; reason: string; title: string }) => {
          if (variants.length >= options.count) return { error: 'Enough versions already.', ok: false }
          const changes = applicable(document, input.changes)
          if (!changes) {
            return { error: 'Those changes do not produce a valid design. Check option ids and units.', ok: false }
          }
          const problem = distinctnessProblem(
            changes,
            variants.map((variant) => variant.changes),
            options.instruction,
            document
          )
          if (problem) return { error: problem, ok: false }
          variants.push({ changes, reason: input.reason, title: input.title })
          return { ok: true, remaining: options.count - variants.length }
        },
        inputSchema: z.object({
          changes: designChangesSchema,
          reason: z.string().max(200).describe('One sentence on what makes this version different.'),
          title: z.string().max(60).describe('A short name for the version.'),
        }),
      }),
    },
  })
  return variants
}

/** Estimate a range before generation from the configured model and serialized design. */
export function estimateVariantCredits(document: DesignDocument, count: number) {
  const model = models.modelId('deep')
  // Include the catalog and tool schema overhead; tokenization and cache hits vary.
  const input = Math.ceil(designContext(document).length / 3) + 8000
  const lower = settleCredits(tokenCostUsd(model, { input, output: count * 800, cacheRead: 0, cacheWrite: 0 }))
  const upper = settleCredits(tokenCostUsd(model, { input: (input + count * 2400) * (count + 4), output: (count + 4) * 2400, cacheRead: 0, cacheWrite: 0 }))
  return { lower, upper, model }
}

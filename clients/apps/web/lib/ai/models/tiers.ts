import { z } from 'zod'
import type { AssistantSurfaceKind } from '@/lib/assistant/page-context'

/**
 * Curated AI model tiers, reasoning effort levels, and per-surface routing
 * defaults shared between Settings, the unified Assistant composer, and server
 * model resolution.
 */

/** Maximum characters for workspace-wide standing AI instructions. */
export const AI_INSTRUCTIONS_MAX = 4_000

/** User-selectable capability tiers backed by curated OpenRouter models. */
export const aiModelTierSchema = z.enum(['fast', 'balanced', 'deep'])

/** A curated AI model tier. */
export type AiModelTier = z.infer<typeof aiModelTierSchema>

/** Reasoning effort levels passed to OpenRouter when supported. */
export const aiEffortSchema = z.enum(['low', 'medium', 'high'])

/** A reasoning effort level. */
export type AiEffort = z.infer<typeof aiEffortSchema>

/** Model tier + reasoning effort preference for one slot or thread. */
const aiModelPreferenceSchema = z.object({
  effort: aiEffortSchema.nullish().transform((value) => value ?? 'medium'),
  tier: aiModelTierSchema,
})

/** One model preference. */
export type AiModelPreference = z.infer<typeof aiModelPreferenceSchema>

/** Workspace-level model defaults keyed by entry-point slot; unset slots inherit `default`. */
export const aiModelDefaultsSchema = z.object({
  assistant: aiModelPreferenceSchema.nullable().optional(),
  campaigns: aiModelPreferenceSchema.nullable().optional(),
  default: aiModelPreferenceSchema.nullable().optional(),
  editors: aiModelPreferenceSchema.nullable().optional(),
  writing: aiModelPreferenceSchema.nullable().optional(),
})

/** Parsed workspace AI model defaults. */
export type AiModelDefaults = z.infer<typeof aiModelDefaultsSchema>

/** An AI surface routing slot. */
export type AiSurfaceSlot = keyof AiModelDefaults

/** Metadata for each curated tier rendered in Settings and the Assistant composer. */
type AiModelTierDefinition = {
  description: string
  id: AiModelTier
  label: string
  modelId: string
  modelName: string
  /** True when the tier requires a workspace-supplied OpenRouter API key (BYOK). */
  requiresApiKey: boolean
}

/** Curated model catalog: Claude Haiku 5.5 is included out of the box; Sonnet & Opus require BYOK. */
export const AI_MODEL_TIERS: Record<AiModelTier, AiModelTierDefinition> = {
  fast: {
    description: 'Included out of the box for instant lookups, edits, and everyday workspace help.',
    id: 'fast',
    label: 'Fast',
    modelId: 'anthropic/claude-haiku-5.5',
    modelName: 'Claude Haiku 5.5',
    requiresApiKey: false,
  },
  balanced: {
    description: 'Higher craft for visual composition, Store copy, and brand-voiced writing.',
    id: 'balanced',
    label: 'Balanced',
    modelId: 'anthropic/claude-sonnet-5.5',
    modelName: 'Claude Sonnet 5.5',
    requiresApiKey: true,
  },
  deep: {
    description: 'Maximum reasoning for launch kits, multi-slide critiques, and complex tasks.',
    id: 'deep',
    label: 'Deep',
    modelId: 'anthropic/claude-opus-5.5',
    modelName: 'Claude Opus 5.5',
    requiresApiKey: true,
  },
}

/** Returns true when `tier` requires a workspace BYOK OpenRouter API key. */
export function tierRequiresApiKey(tier: AiModelTier): boolean {
  return AI_MODEL_TIERS[tier].requiresApiKey
}

/** Ordered list of tiers for dropdown menus. */
export const AI_MODEL_TIER_LIST: readonly AiModelTierDefinition[] = [
  AI_MODEL_TIERS.fast,
  AI_MODEL_TIERS.balanced,
  AI_MODEL_TIERS.deep,
]

/** Human labels for reasoning effort levels. */
export const AI_EFFORT_LABELS: Record<AiEffort, { label: string; short: string }> = {
  low: { label: 'Low', short: 'Low' },
  medium: { label: 'Medium', short: 'Med' },
  high: { label: 'High', short: 'High' },
}

/** Entry-point rows shown in Settings → AI & Agents → Models & usage. */
export const AI_SURFACE_SLOTS: readonly {
  description: string
  id: AiSurfaceSlot
  label: string
}[] = [
  {
    description: 'Used for Ask AI threads across Home, Library, Releases, and Settings.',
    id: 'assistant',
    label: 'Workspace assistant',
  },
  {
    description: 'Used in Screenshot Editor, Store Screenshots, Canvas, Code, Story Sets, and Tweet.',
    id: 'editors',
    label: 'Visual editors',
  },
  {
    description: 'Used for Ask AI threads in the post composer.',
    id: 'writing',
    label: 'Writing assistant',
  },
  {
    description: 'Used for Ask AI threads on campaign pages.',
    id: 'campaigns',
    label: 'Campaign assistant',
  },
  {
    description: 'Fallback for every assistant surface without its own override.',
    id: 'default',
    label: 'Workspace default',
  },
]

/** System fallback when a workspace has not customized any defaults yet. */
const SYSTEM_DEFAULT_PREFERENCE: AiModelPreference = {
  effort: 'medium',
  tier: 'fast',
}

/** Map an active assistant surface kind to its routing slot. */
export function surfaceToAiSlot(surface?: AssistantSurfaceKind): AiSurfaceSlot {
  if (!surface || surface === 'none') return 'assistant'
  if (surface === 'write-composer') return 'writing'
  if (surface === 'campaign') return 'campaigns'
  return 'editors'
}

/** Parse raw JSON from WorkspaceSettings safely into validated defaults. */
export function parseWorkspaceAiDefaults(raw: unknown): AiModelDefaults {
  const parsed = aiModelDefaultsSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

/** Resolve the effective model preference for `slot` plus where it was inherited from. */
export function resolveEffectivePreference(
  defaults: AiModelDefaults | null | undefined,
  slot: AiSurfaceSlot
): AiModelPreference & { inheritedFrom: 'surface' | 'workspace' | 'system' } {
  const slotPref = slot !== 'default' ? defaults?.[slot] : null
  if (slotPref) return { ...slotPref, inheritedFrom: 'surface' }
  const workspacePref = defaults?.default
  if (workspacePref) return { ...workspacePref, inheritedFrom: 'workspace' }
  return { ...SYSTEM_DEFAULT_PREFERENCE, inheritedFrom: 'system' }
}

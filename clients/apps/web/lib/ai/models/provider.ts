import { createOpenRouter, type OpenRouterChatSettings } from '@openrouter/ai-sdk-provider'
import { testHooksAllowed } from '@/lib/e2e-hooks'

const OPENAI_MODEL_PREFIX = 'openai/'
const ANTHROPIC_MODEL_PREFIX = 'anthropic/'

/**
 * Qualifies an existing OpenAI model id for OpenRouter without changing the
 * selected model. Already-qualified ids are left unchanged so incident
 * overrides can use OpenRouter's native model format.
 */
export function toOpenRouterModelId(modelId: string): string {
  return modelId.includes('/') ? modelId : `${OPENAI_MODEL_PREFIX}${modelId}`
}

/**
 * Routing every OpenRouter request uses. Endpoints that may store or train on
 * prompts are skipped, which backs the public "no training on your content"
 * promise.
 */
export const OPENROUTER_PROVIDER_PREFERENCES = { data_collection: 'deny' } as const

/**
 * Settings every model gets. Usage accounting returns each call's cost, which
 * the AI credit meter charges. On Anthropic models, automatic prompt caching
 * marks the newest message each step, so a multi-step agent reads its growing
 * history from cache instead of paying full input price for it every step.
 */
export function openRouterSettings(modelId: string): OpenRouterChatSettings {
  return {
    provider: OPENROUTER_PROVIDER_PREFERENCES,
    usage: { include: true },
    ...(modelId.startsWith(ANTHROPIC_MODEL_PREFIX) ? { cache_control: { type: 'ephemeral' } } : {}),
  }
}

/**
 * A local stand-in provider (docs/ai-emulator.md), from OPENROUTER_BASE_URL.
 * Prompts carry customer data, so the override works only where test hooks may:
 * a developer's machine or the end-to-end stack, never a deployment.
 */
export function openRouterBaseURL(): string | undefined {
  const override = process.env.OPENROUTER_BASE_URL?.trim()
  return override && testHooksAllowed() ? override : undefined
}

/** Shared OpenRouter provider. Credentials are read from OPENROUTER_API_KEY. */
export const openRouterProvider = createOpenRouter({ baseURL: openRouterBaseURL() })

/** Resolves an existing language model through OpenRouter. */
export function openRouterLanguageModel(modelId: string) {
  const id = toOpenRouterModelId(modelId)
  return openRouterProvider(id, openRouterSettings(id))
}

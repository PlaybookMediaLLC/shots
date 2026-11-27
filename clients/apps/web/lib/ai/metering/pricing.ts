import { z } from 'zod'

/**
 * What a model call costs, in US dollars and AI credits. Pure, so the meter
 * and its tests share one definition (docs/rfcs/023-pricing-and-unit-economics.md).
 */

/** One AI credit is one cent of model spend at list price. */
export const USD_PER_CREDIT = 0.01

/** List price per million tokens. */
export const modelPriceSchema = z.object({
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
})

/** List price per million tokens. */
export type ModelPrice = z.infer<typeof modelPriceSchema>

/**
 * List prices by OpenRouter model id. Anthropic cache writes are 1.25 times
 * input; reads are the published cache-read rate.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Haiku 5.5 bills $0.10 / $0.50 up to 100K prompt tokens; this is its longer-prompt rate, so the meter never undercharges.
  'anthropic/claude-haiku-5.5': { cacheRead: 0.05, cacheWrite: 0.625, input: 0.5, output: 2.5 },
  'anthropic/claude-opus-5.5': { cacheRead: 0.2, cacheWrite: 5, input: 4, output: 20 },
  'anthropic/claude-sonnet-5.5': { cacheRead: 0.2, cacheWrite: 2.5, input: 2, output: 10 },
  'anthropic/claude-haiku-4.5': { cacheRead: 0.1, cacheWrite: 1.25, input: 1, output: 5 },
  'google/gemini-2.5-flash': { cacheRead: 0.075, cacheWrite: 0.3, input: 0.3, output: 2.5 },
}

/** An unlisted model is priced as the most expensive one, so the meter never undercharges. */
export const UNLISTED_MODEL_PRICE: ModelPrice = MODEL_PRICES['anthropic/claude-opus-5.5']

/** Token counts for one call, split the way prices are. */
export type CallTokens = {
  cacheRead: number
  cacheWrite: number
  /** Input tokens that were neither read from nor written to the cache. */
  input: number
  output: number
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * Reads AI SDK v7 usage (`inputTokens.{total,noCache,cacheRead,cacheWrite}`,
 * `outputTokens.total`), tolerating the flat counts older shapes used.
 */
export function callTokens(usage: unknown): CallTokens {
  const record = (usage ?? {}) as Record<string, unknown>
  const input = record.inputTokens
  const output = record.outputTokens
  if (input && typeof input === 'object') {
    const bucket = input as Record<string, unknown>
    const cacheRead = count(bucket.cacheRead)
    const cacheWrite = count(bucket.cacheWrite)
    const noCache =
      bucket.noCache === undefined
        ? Math.max(count(bucket.total) - cacheRead - cacheWrite, 0)
        : count(bucket.noCache)
    return {
      cacheRead,
      cacheWrite,
      input: noCache,
      output: count(
        output && typeof output === 'object' ? (output as { total?: unknown }).total : output
      ),
    }
  }
  return { cacheRead: 0, cacheWrite: 0, input: count(input), output: count(output) }
}

/** Cost from token counts at list price. */
export function tokenCostUsd(modelId: string, tokens: CallTokens): number {
  const price = MODEL_PRICES[modelId] ?? UNLISTED_MODEL_PRICE
  return (
    (tokens.input * price.input +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite +
      tokens.output * price.output) /
    1_000_000
  )
}

/** The cost OpenRouter reported for the call, when usage accounting is on. */
export function reportedCostUsd(providerMetadata: unknown): number | null {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
    ?.openrouter?.usage?.cost
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null
}

/**
 * What one call cost. The provider's reported cost wins because it reflects
 * cache hits exactly; token counts at list price are the fallback.
 */
export function callCostUsd(modelId: string, usage: unknown, providerMetadata: unknown): number {
  return reportedCostUsd(providerMetadata) ?? tokenCostUsd(modelId, callTokens(usage))
}

/** Whole credits owed for a dollar amount, and the fraction carried to the next call. */
export function splitCredits(usd: number): { credits: number; carryUsd: number } {
  // Tolerance keeps 0.07 + 0.03 from flooring to 9 credits.
  const credits = Math.floor(usd / USD_PER_CREDIT + 1e-9)
  return { credits, carryUsd: Math.max(usd - credits * USD_PER_CREDIT, 0) }
}

/** Credits for a final remainder, rounded up so spend is never under-counted. */
export function settleCredits(usd: number): number {
  return usd > 1e-9 ? Math.ceil(usd / USD_PER_CREDIT - 1e-9) : 0
}

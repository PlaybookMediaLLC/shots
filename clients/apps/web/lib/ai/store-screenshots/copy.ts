import 'server-only'

import { generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { WritingContext } from 'screenshot-studio-backend-sdk'
import { models } from '@/lib/ai/models'
import type { CopyRequest } from '@/lib/api/contracts/store-screenshots'
import { voiceInstructions } from '@/lib/write/voice'

/**
 * Headline suggestions for store screenshots, grounded only in the product
 * facts the user supplies. The instructions forbid invented numbers,
 * rankings, awards, and comparisons; suggestions that contain digits not
 * present in the brief are dropped as a second line of defence.
 */

/** Tool the model must call with its suggestions. */
export const SUBMIT_COPY_TOOL = 'submitCopySuggestions'

const LIMITS = { short: { headline: 32, subheadline: 60 }, long: { headline: 60, subheadline: 110 } } as const

function instructions(request: CopyRequest): string {
  const limit = LIMITS[request.length]
  return `You write benefit-led headlines for App Store and Google Play screenshots.
Rules:
- Use only facts stated in the product brief. If the brief does not say it, do not claim it.
- Never invent numbers, percentages, user counts, ratings, rankings, awards, prices, or comparisons with competitors.
- Lead with the user's benefit, not the feature name. One idea per slide.
- Headline at most ${limit.headline} characters; subheadline at most ${limit.subheadline} characters (may be empty).
- Write in the language of locale ${request.locale}, natural for that market.
- Tone: ${request.tone}.
- Give ${request.count} distinct variants per slide and a one-sentence rationale each.
- Call ${SUBMIT_COPY_TOOL} once with every slide id.`
}

const answerSchema = z.object({
  slides: z.array(
    z.object({
      id: z.string(),
      suggestions: z.array(z.object({ headline: z.string(), subheadline: z.string().default(''), rationale: z.string().default('') })),
    })
  ),
})

function digits(text: string): string[] {
  return text.match(/\d+([.,]\d+)?/g) ?? []
}

/**
 * Generate suggestions for each slide, in the brand voice. The request's tone
 * is the user's choice for this set and wins where the two differ.
 */
export async function suggestCopy(request: CopyRequest, voice: WritingContext | null) {
  const limit = LIMITS[request.length]
  const result = await generateText({
    model: models.languageModel('drafting'),
    // The request's tone is the user's choice for this set: the voice gives the rest.
    system: instructions(request) + voiceInstructions(voice && { ...voice, tone: '' }),
    prompt: `Product brief:\n${request.brief}\n\nSlides:\n${JSON.stringify(request.slides)}`,
    tools: {
      [SUBMIT_COPY_TOOL]: tool({ description: 'Submit headline suggestions for every slide.', inputSchema: answerSchema }),
    },
    toolChoice: { type: 'tool', toolName: SUBMIT_COPY_TOOL },
    stopWhen: stepCountIs(1),
  })
  const call = result.toolCalls.find((item) => item.toolName === SUBMIT_COPY_TOOL)
  const parsed = answerSchema.safeParse(call?.input)
  if (!parsed.success) throw new Error('The copy service returned an unreadable answer.')
  const briefDigits = new Set(digits(request.brief))
  const wanted = new Set(request.slides.map((slide) => slide.id))
  return {
    slides: parsed.data.slides
      .filter((slide) => wanted.has(slide.id))
      .map((slide) => ({
        id: slide.id,
        suggestions: slide.suggestions
          .filter((item) => item.headline.trim())
          .filter((item) => digits(`${item.headline} ${item.subheadline}`).every((value) => briefDigits.has(value)))
          .map((item) => ({
            headline: item.headline.trim().slice(0, limit.headline + 10),
            subheadline: item.subheadline.trim().slice(0, limit.subheadline + 20),
            rationale: item.rationale.trim().slice(0, 240),
          }))
          .slice(0, request.count),
      })),
  }
}

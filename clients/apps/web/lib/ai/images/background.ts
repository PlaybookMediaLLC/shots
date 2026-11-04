import 'server-only'

import sharp from 'sharp'
import { z } from 'zod'
import { aiCreditMeter } from '@/lib/ai/metering'
import { OPENROUTER_PROVIDER_PREFERENCES } from '@/lib/ai/models/provider'
import { isScriptedModelEnabled } from '@/lib/ai/models/scripted'
import {
  type BackgroundRequest,
  backgroundPrompt,
  backgroundRequestSchema,
  backgroundSize,
} from './background-request'

/**
 * AI backgrounds: an image model draws a background from a description and,
 * optionally, a palette (a brand kit's colours or the screenshot's own).
 * The result is resized to the canvas shape and stored as a workspace image,
 * so it is an ordinary image background from then on: saved, undone, and
 * exported like any other.
 *
 * The model is called through OpenRouter's image generation (chat
 * completions with image output) and charged to the workspace's AI credits
 * from the cost OpenRouter reports.
 */

/** Charged when the provider reports no cost for an image (about one image at list price). */
const FALLBACK_IMAGE_COST_USD = 0.04

/** The default image model; override with PLATFORM_AI_IMAGE_MODEL. */
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image'
/** The generator refused or failed, with a message for the user. */
export class BackgroundGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackgroundGenerationError'
  }
}

const imageResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          images: z.array(z.object({ image_url: z.object({ url: z.string() }) })).optional(),
        }),
      })
    )
    .min(1),
  usage: z.object({ cost: z.number().optional() }).optional(),
})

/** Draw an image from a finished prompt, charged to the workspace's AI credits. */
export async function callImageModel(prompt: string, aspect: string): Promise<Buffer> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new BackgroundGenerationError('AI is not configured for this environment.')
  const record = await aiCreditMeter.admit()
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    body: JSON.stringify({
      image_config: { aspect_ratio: aspect },
      messages: [{ content: prompt, role: 'user' }],
      modalities: ['image', 'text'],
      model: process.env.PLATFORM_AI_IMAGE_MODEL?.trim() || DEFAULT_IMAGE_MODEL,
      provider: OPENROUTER_PROVIDER_PREFERENCES,
      usage: { include: true },
    }),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new BackgroundGenerationError(
      response.status === 402
        ? 'The AI provider account is out of credit. Try again later.'
        : response.status === 429
          ? 'The image model is busy. Try again in a minute.'
          : `The image model failed (${response.status}). ${detail.slice(0, 200)}`.trim()
    )
  }
  const body = imageResponseSchema.parse(await response.json())
  // A response without a reported cost is still charged, at a typical image price.
  await record(body.usage?.cost ?? FALLBACK_IMAGE_COST_USD)
  const url = body.choices[0]!.message.images?.[0]?.image_url.url
  const data = url?.match(/^data:image\/[a-z+]+;base64,(.+)$/)?.[1]
  if (!data) {
    throw new BackgroundGenerationError(
      'The model returned no image. Try describing it differently.'
    )
  }
  return Buffer.from(data, 'base64')
}

/**
 * A deterministic stand-in for tests (PLATFORM_AI_SCRIPTED=1, never in
 * production): a soft gradient in the palette, so the flow runs offline.
 */
export function scriptedImage(
  request: Pick<BackgroundRequest, 'palette'>,
  size: { height: number; width: number }
): Buffer {
  const [from = '#4f46e5', to = '#ec4899'] = request.palette
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}">` +
      `<defs><radialGradient id="g" cx="0.3" cy="0.3" r="1"><stop offset="0" stop-color="${to}"/>` +
      `<stop offset="1" stop-color="${from}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
  )
}

/** Generate a background and return it as a WebP at the canvas shape. */
export async function generateBackground(
  input: BackgroundRequest
): Promise<{ body: Buffer; height: number; width: number }> {
  const request = backgroundRequestSchema.parse(input)
  const size = backgroundSize(request.aspect)
  const source = isScriptedModelEnabled()
    ? scriptedImage(request, size)
    : await callImageModel(backgroundPrompt(request), request.aspect)
  const body = await sharp(source)
    .resize(size.width, size.height, { fit: 'cover', position: 'attention' })
    .webp({ quality: 90 })
    .toBuffer()
  return { body, ...size }
}

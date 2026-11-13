import 'server-only'
import { z } from 'zod'
import { backendSDK } from '@/lib/backend/sdk'
import type { senjaVideoSchema } from '@/lib/api/contracts/senja'
import { openCredentials, sealCredentials } from '@/lib/integrations/crypto'
import { safeFetchBytes, type SafeFetchOptions } from '@/lib/launch/safe-fetch'

/**
 * Senja import (composer slice 3c): a workspace admin pastes the Senja
 * project's own API key (Senja has no OAuth app). It is sealed like other
 * integration credentials and stored as the workspace's one SENJA
 * integration; Senja's API takes it as a Bearer token. Nothing reaches Senja
 * but that key, and nothing reaches the browser but what a member may see.
 */

type BackendContext = Parameters<typeof backendSDK>[0]

const API = 'https://api.senja.io/v1'
/** The workspace has one Senja key: saving again replaces it. */
const EXTERNAL_ID = 'senja'
/** The newest approved video testimonials offered at a time. */
const VIDEO_LIMIT = 100
/**
 * An imported video is held whole in the web server's memory (twice, while
 * it is read), so Senja imports stop well below the upload's own video limit.
 */
export const SENJA_MAX_BYTES = 150 * 1024 * 1024

// One odd field drops only itself: an unusable address is read as none.
const address = z.string().url().nullish().catch(null)
const testimonialSchema = z.object({
  approved: z.boolean().nullish().catch(null),
  customer_name: z.string().nullish().catch(null),
  id: z.string().min(1),
  thumbnail_url: address,
  video: z.object({ duration: z.number().nullish() }).nullish().catch(null),
  video_url: address,
})
type Testimonial = z.infer<typeof testimonialSchema>

/** A video testimonial, as the composer offers it. */
export type SenjaVideo = z.infer<typeof senjaVideoSchema>

/** Senja answered; `status` is what Shots answers its caller. */
export class SenjaError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 422 | 503
  ) {
    super(message)
    this.name = 'SenjaError'
  }
}

/** How Shots reaches Senja: its API, and the media its answers point to. */
export type SenjaTransport = { media?: SafeFetchOptions; request?: typeof fetch }

async function senja(key: string, path: string, request: typeof fetch = fetch): Promise<unknown> {
  const response = await request(`${API}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!response) throw new SenjaError('Senja could not be reached. Try again later.', 503)
  if (response.status === 401 || response.status === 403)
    throw new SenjaError(
      'Senja refused the API key. Copy it again from Senja’s Integrations page.',
      422
    )
  if (response.status === 404) throw new SenjaError('That testimonial is no longer in Senja.', 404)
  if (!response.ok) throw new SenjaError('Senja did not answer. Try again later.', 503)
  return response.json().catch(() => {
    throw new SenjaError('Senja sent an answer Shots could not read.', 503)
  })
}

function video(testimonial: Testimonial): SenjaVideo {
  return {
    customerName: testimonial.customer_name?.trim() || 'A customer',
    durationSeconds: testimonial.video?.duration ?? null,
    id: testimonial.id,
    thumbnailUrl: testimonial.thumbnail_url ?? null,
  }
}

/** The newest approved video testimonials of the key's Senja project. */
export async function listSenjaVideos(key: string, request?: typeof fetch): Promise<SenjaVideo[]> {
  const parameters = new URLSearchParams({
    approved: 'true',
    limit: String(VIDEO_LIMIT),
    order: 'desc',
    sort: 'date',
    type: 'video',
  })
  const body = z
    .object({ testimonials: z.array(z.unknown()) })
    .safeParse(await senja(key, `/testimonials?${parameters}`, request))
  if (!body.success) throw new SenjaError('Senja sent an answer Shots could not read.', 503)
  // A testimonial Shots cannot read, or without a video, is left out; the others still list.
  return body.data.testimonials.flatMap((item) => {
    const parsed = testimonialSchema.safeParse(item)
    return parsed.success && parsed.data.video_url && parsed.data.approved !== false
      ? [video(parsed.data)]
      : []
  })
}

/**
 * A testimonial's video, re-read from Senja by id so the browser never names
 * the address Shots fetches. The fetch is SSRF-guarded and bounded by
 * {@link SENJA_MAX_BYTES}; Go probes the bytes as an MP4 when they are stored.
 */
export async function senjaVideoFile(
  key: string,
  id: string,
  transport: SenjaTransport = {}
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
  const answer = await senja(key, `/testimonials/${encodeURIComponent(id)}`, transport.request)
  const parsed = z
    .union([testimonialSchema, z.object({ testimonial: testimonialSchema })])
    .safeParse(answer)
  if (!parsed.success) throw new SenjaError('Senja sent an answer Shots could not read.', 503)
  const testimonial = 'testimonial' in parsed.data ? parsed.data.testimonial : parsed.data
  // The list offers approved testimonials only; an id sent directly is held to the same rule.
  if (testimonial.approved === false)
    throw new SenjaError('That testimonial is not approved in Senja.', 422)
  if (!testimonial.video_url) throw new SenjaError('That testimonial has no video.', 422)
  const fetched = await safeFetchBytes(testimonial.video_url, {
    ...transport.media,
    maxBytes: SENJA_MAX_BYTES,
    timeoutMs: 120_000,
  })
  if (!fetched.ok)
    throw new SenjaError('The video could not be fetched from Senja. Try again.', 503)
  if (fetched.truncated)
    throw new SenjaError('The video is larger than Shots imports from Senja (150 MB).', 422)
  // A CDN may label an MP4 generically.
  if (!/^(video\/mp4|application\/octet-stream)\b/.test(fetched.contentType))
    throw new SenjaError('Senja did not send the video as an MP4.', 422)
  // Go takes ASCII file names only: accents go, and a name in another script becomes a plain one.
  const name =
    video(testimonial)
      .customerName.normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'testimonial'
  return { bytes: fetched.bytes, contentType: 'video/mp4', fileName: `senja-${name}.mp4` }
}

async function connection(context: BackendContext) {
  const { integrations } = await backendSDK(context).listIntegrations()
  return integrations.find((integration) => integration.provider === 'SENJA') ?? null
}

/** Whether the workspace has saved a Senja key. */
export async function senjaConfigured(context: BackendContext): Promise<boolean> {
  return (await connection(context)) !== null
}

/** The workspace's Senja key, or null until an admin saves one. */
export async function senjaKey(context: BackendContext): Promise<string | null> {
  const saved = await connection(context)
  if (!saved) return null
  const stored = await backendSDK(context).integrationCredentials(saved.id)
  return openCredentials(stored.encryptedCredentials).accessToken
}

/** Checks the key with Senja, then seals and saves it, replacing any earlier one. */
export async function saveSenjaKey(
  context: BackendContext,
  key: string,
  request?: typeof fetch
): Promise<void> {
  await senja(key, '/testimonials?limit=1', request)
  await backendSDK(context).saveIntegration({
    displayName: 'Senja',
    encryptedCredentials: sealCredentials({ accessToken: key }),
    externalId: EXTERNAL_ID,
    provider: 'SENJA',
    scopes: [],
    tokenExpiresAt: null,
  })
}

/** Forgets the workspace's Senja key. */
export async function removeSenjaKey(context: BackendContext): Promise<void> {
  const saved = await connection(context)
  if (saved) await backendSDK(context).deleteIntegration(saved.id)
}

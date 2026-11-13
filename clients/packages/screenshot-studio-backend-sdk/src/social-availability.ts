import { z } from 'zod'

/** Product connection branches, including adapters used by existing accounts. */
export const connectionProviderSchema = z.enum([
  'x',
  'linkedin',
  'linkedin-page',
  'tiktok',
  'youtube',
  'threads',
  'mastodon',
  'mastodon-custom',
  'bluesky',
  'instagram',
  'instagram-standalone',
  'substack',
  'facebook',
  'pinterest',
])

/** Readiness is configuration only; it does not establish account authorization. */
export const providerAvailabilitySchema = z.strictObject({
  provider: connectionProviderSchema,
  status: z.enum(['available', 'not_configured', 'disabled', 'unsupported']),
})

/** Fail closed on missing/duplicate providers instead of assuming readiness. */
export const connectionAvailabilitySchema = z
  .strictObject({
    version: z.literal(1),
    providers: z.array(providerAvailabilitySchema).length(connectionProviderSchema.options.length),
  })
  .refine(
    (value) =>
      new Set(value.providers.map((item) => item.provider)).size ===
      connectionProviderSchema.options.length,
    {
      message: 'The connection catalog is incomplete or contains duplicate providers.',
    }
  )

/** A validated, credential-free runtime connection catalog. */
export type ConnectionAvailability = z.output<typeof connectionAvailabilitySchema>

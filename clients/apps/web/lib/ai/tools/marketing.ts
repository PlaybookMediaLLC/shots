import { z } from 'zod'
import type { getActiveBrand } from '@/lib/launch/store'
import type { transitionCampaignPosts } from '@/lib/tenant/campaigns'
import type { getProductProfile } from '@/lib/tenant/product-profile'
import type {
  captureProductSurface,
  findSurfacesForFeature,
  listProductSurfaces,
} from '@/lib/tenant/product-surfaces'
import { defineTool, type ToolRun } from './executor'

/**
 * The RFC 027 marketing tools: read the workspace's product, brand, and
 * product surfaces, capture a registered surface, and submit posts for
 * review. Nothing here approves, schedules, or publishes, and capture takes a
 * surface slug, never a URL, so the model cannot point it at another host.
 *
 * The domain services are passed in (`marketingServices` on the server), so
 * the tools run against fakes in tests.
 */

/** The domain services the marketing tools call, the same ones the UI uses. */
export type MarketingServices = {
  captureProductSurface: typeof captureProductSurface
  findSurfacesForFeature: typeof findSurfacesForFeature
  getActiveBrand: typeof getActiveBrand
  getProductProfile: typeof getProductProfile
  listProductSurfaces: typeof listProductSurfaces
  transitionCampaignPosts: typeof transitionCampaignPosts
}

const failure = (error: string) => ({ error, ok: false as const })

/**
 * The marketing tool set for one run. `campaignId` is the campaign the run
 * works on; without one, `requestApproval` refuses.
 */
export function marketingTools(
  run: ToolRun,
  { campaignId, services }: { campaignId?: string; services: MarketingServices }
) {
  const getProduct = defineTool(run, {
    description:
      "Read the workspace's product profile: name, summary, problem, audience, capabilities, " +
      'competitors, pricing, and proof points. Returns null when no profile is saved.',
    effect: 'read',
    execute: async () => {
      const profile = await services.getProductProfile(run.access)
      if (!profile) return { ok: true as const, product: null }
      // Ids, dates, and provenance stay out of the model's context.
      const { createdAt: _c, id: _i, provenance: _p, updatedAt: _u, ...product } = profile
      return { ok: true as const, product }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 5,
    name: 'getProduct',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const getBrand = defineTool(run, {
    description:
      "Read the workspace's active brand kit (colors, font) and brand voice (tone, audience, " +
      'tagline, prohibited terms). Either is null when not set.',
    effect: 'read',
    execute: async () => {
      const { kit, voice } = await services.getActiveBrand(run.access)
      return { kit, ok: true as const, voice }
    },
    inputSchema: z.object({}),
    maxCallsPerRun: 5,
    name: 'getBrand',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const listProductSurfaces = defineTool(run, {
    description:
      'List the product pages the workspace registered, by slug. Pass a feature to rank the ' +
      'pages that show it, best first; a "fallback" match is the homepage, not the feature.',
    effect: 'read',
    execute: async ({ feature, limit }) => {
      if (feature) {
        const matches = await services.findSurfacesForFeature(run.access, { feature, limit })
        return {
          ok: true as const,
          surfaces: matches.map(({ currentCaptureAssetId, reason, score, surface }) => ({
            captured: Boolean(currentCaptureAssetId),
            description: surface.description,
            featureTags: surface.featureTags,
            name: surface.name,
            reason,
            score,
            slug: surface.slug,
          })),
        }
      }
      const surfaces = await services.listProductSurfaces(run.access)
      return {
        ok: true as const,
        surfaces: surfaces.slice(0, limit).map((surface) => ({
          captured: surface.screenshotAssetIds.length > 0,
          description: surface.description,
          featureTags: surface.featureTags,
          name: surface.name,
          slug: surface.slug,
        })),
      }
    },
    inputSchema: z.object({
      feature: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    maxCallsPerRun: 10,
    name: 'listProductSurfaces',
    permission: 'workspace:read',
    timeoutMs: 10_000,
  })

  const captureProductSurface = defineTool(run, {
    description:
      'Take a fresh screenshot of a registered product page, by its slug from ' +
      'listProductSurfaces, and make it the page’s current capture. Returns the assetId. A page ' +
      'behind a sign-in is captured in the background: it returns pending with no assetId yet.',
    effect: 'external',
    execute: async ({ slug }) => {
      const surfaces = await services.listProductSurfaces(run.access)
      const surface = surfaces.find((entry) => entry.slug === slug)
      if (!surface) return failure('Unknown slug. Use one from listProductSurfaces.')
      const result = await services.captureProductSurface(run.access, surface.id, {
        source: 'agent',
        sourceId: run.runId,
      })
      if (!result) return failure('Unknown slug. Use one from listProductSurfaces.')
      if ('failure' in result) return failure(result.failure.message)
      if ('job' in result) {
        return {
          message:
            'The capture is running. The screenshot becomes the page’s current capture when it ends.',
          ok: true as const,
          pending: true as const,
          slug,
        }
      }
      return { assetId: result.capture.assetId, ok: true as const, slug }
    },
    inputSchema: z.object({ slug: z.string().trim().min(1).max(200) }),
    maxCallsPerRun: 10,
    name: 'captureProductSurface',
    permission: 'release:create',
    timeoutMs: 90_000,
  })

  const requestApproval = defineTool(run, {
    description:
      "Submit this campaign's draft posts for human review. It never approves: a reviewer " +
      'decides. Pass the post ids to submit.',
    effect: 'mutate',
    execute: async ({ postIds }) => {
      if (!campaignId) return failure('This run has no campaign to submit posts from.')
      // Submit only: approval needs a person (RFC 012).
      const result = await services.transitionCampaignPosts(
        run.access,
        campaignId,
        'submit',
        postIds
      )
      return { ok: true as const, status: result.status, submitted: result.postIds }
    },
    inputSchema: z.object({ postIds: z.array(z.string().cuid()).min(1).max(30) }),
    maxCallsPerRun: 2,
    name: 'requestApproval',
    permission: 'release:create',
    timeoutMs: 30_000,
  })

  return { captureProductSurface, getBrand, getProduct, listProductSurfaces, requestApproval }
}

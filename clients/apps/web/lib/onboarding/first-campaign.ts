import 'server-only'

import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { LaunchError } from '@/lib/launch/store'
import { createRelease } from '@/lib/tenant/releases'
import { getProductProfile, type StoredProductProfile } from '@/lib/tenant/product-profile'

/**
 * Workflow 1's setup (docs/rfcs/048-core-workflows.md): from the confirmed
 * product profile, a product surface for the product's URL, a release brief
 * synthesized from the profile and citing the pages onboarding read, and a
 * launch campaign. Review continues on the persisted campaign's stage pages.
 */

/** Source pages a first campaign cites besides the product URL. */
const MAX_SOURCE_PAGES = 4
// One first campaign per workspace; intentional new work uses Campaigns → New.
const FIRST_CAMPAIGN_KEY = 'onboarding:first-campaign:v1'

/** Release fields are plain text: markup characters are dropped, not escaped. */
export const plain = (value: string, max: number) => value.replace(/[<>]/g, '').trim().slice(0, max)

/** The product surface for the profile's URL, created on first use. */
export async function ensureProductSurface(
  access: OrganizationAccess,
  profile: StoredProductProfile
) {
  const backend = backendSDK(access)
  const { productSurfaces } = await backend.listProductSurfaces()
  const existing = productSurfaces.find((candidate) => candidate.url === profile.url)
  if (existing) return existing
  try {
    return await backend.createProductSurface({
      description: plain(profile.summary, 1_000) || undefined,
      environment: 'production',
      featureTags: [],
      name: profile.name,
      screenshotAssetIds: [],
      url: profile.url,
    })
  } catch (error) {
    if (!(error instanceof BackendSDKError) || error.status !== 409) throw error
    const { productSurfaces: current } = await backend.listProductSurfaces()
    const concurrent = current.find((candidate) => candidate.url === profile.url)
    if (!concurrent) throw error
    return concurrent
  }
}

function briefDescription(profile: StoredProductProfile): string {
  return [
    profile.problem ? `Problem: ${profile.problem}` : null,
    profile.capabilities.length
      ? `Capabilities:\n${profile.capabilities.map((item) => `- ${item}`).join('\n')}`
      : null,
    profile.proofPoints.length
      ? `Proof points:\n${profile.proofPoints.map((point) => `- ${point.claim}`).join('\n')}`
      : null,
    profile.pricingNote ? `Pricing: ${profile.pricingNote}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Create the first campaign or resume the workspace's persisted submission. */
export async function startFirstCampaign(
  access: OrganizationAccess,
  pages: readonly string[]
): Promise<{ campaignId: string; created: boolean }> {
  const backend = backendSDK(access)
  const { campaigns } = await backend.listCampaigns({
    idempotencyKey: FIRST_CAMPAIGN_KEY,
    limit: 1,
  })
  if (campaigns[0]) return { campaignId: campaigns[0].id, created: false }
  const profile = await getProductProfile(access)
  if (!profile) throw new LaunchError('Save your product first.', 409)
  const { origin } = new URL(profile.url)
  const sourceUrls = [
    ...new Set(pages.filter((page) => new URL(page).origin === origin && page !== profile.url)),
  ].slice(0, MAX_SOURCE_PAGES)

  const surface = await ensureProductSurface(access, profile)
  const name = plain(`${profile.name} launch`, 160)
  const summary = plain(profile.summary || profile.problem, 500)
  const description = plain(briefDescription(profile), 10_000)
  const { release } = await createRelease(access, {
    audience: plain(profile.audience, 1_000) || undefined,
    benefitStatement: summary,
    description: description || undefined,
    idempotencyKey: FIRST_CAMPAIGN_KEY,
    productSurfaceId: surface.id,
    sourceUrls: sourceUrls.length ? sourceUrls : [profile.url],
    title: name,
  })
  const campaign = await backend.createCampaign({
    idempotencyKey: FIRST_CAMPAIGN_KEY,
    angles: [],
    audience: plain(profile.audience, 1_000) || undefined,
    name,
    objective: 'Launch',
    posts: [],
    productSurfaceId: surface.id,
    releaseId: release.id,
  })
  return { campaignId: campaign.id, created: campaign.created === true }
}

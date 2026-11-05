import 'server-only'

import { randomUUID } from 'node:crypto'
import type { OrganizationAccess } from '@/lib/auth/access'
import { accessAllows } from '@/lib/auth/permissions'
import { backendSDK } from '@/lib/backend/sdk'
import { LaunchError } from '@/lib/launch/store'
import { createRelease } from '@/lib/tenant/releases'
import { getProductProfile, type StoredProductProfile } from '@/lib/tenant/product-profile'

/**
 * Workflow 1's setup (docs/rfcs/048-core-workflows.md): from the confirmed
 * product profile, a product surface for the product's URL, a release brief
 * synthesized from the profile and citing the pages onboarding read, and a
 * launch campaign. The browser then runs spec, plan, and produce on it.
 */

/** Source pages a first campaign cites besides the product URL. */
const MAX_SOURCE_PAGES = 4

/** Release fields are plain text: markup characters are dropped, not escaped. */
export const plain = (value: string, max: number) => value.replace(/[<>]/g, '').trim().slice(0, max)

/** The product surface for the profile's URL, created on first use. */
export async function ensureProductSurface(
  access: OrganizationAccess,
  profile: StoredProductProfile
) {
  const backend = backendSDK(access)
  const { productSurfaces } = await backend.listProductSurfaces()
  return (
    productSurfaces.find((candidate) => candidate.url === profile.url) ??
    (await backend.createProductSurface({
      description: plain(profile.summary, 1_000) || undefined,
      environment: 'production',
      featureTags: [],
      name: profile.name,
      screenshotAssetIds: [],
      url: profile.url,
    }))
  )
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

/** The first campaign, and whether the confirming member may approve its spec and plan. */
export async function startFirstCampaign(
  access: OrganizationAccess,
  pages: readonly string[]
): Promise<{ campaignId: string; canApprove: boolean }> {
  const profile = await getProductProfile(access)
  if (!profile) throw new LaunchError('Save your product first.', 409)
  const backend = backendSDK(access)
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
    idempotencyKey: randomUUID(),
    productSurfaceId: surface.id,
    sourceUrls: sourceUrls.length ? sourceUrls : [profile.url],
    title: name,
  })
  const campaign = await backend.createCampaign({
    angles: [],
    audience: plain(profile.audience, 1_000) || undefined,
    name,
    objective: 'Launch',
    posts: [],
    productSurfaceId: surface.id,
    releaseId: release.id,
  })
  return { campaignId: campaign.id, canApprove: accessAllows(access, 'release:approve') }
}

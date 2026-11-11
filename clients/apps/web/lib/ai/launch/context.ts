import 'server-only'

import { assertPublicCaptureUrl } from '@/lib/screenshot-service'
import type { BrandKitValues } from '@/lib/launch/brand'
import { brandFontId, prohibitedTermList } from '@/lib/launch/brand'
import { defuseMarkup } from '@/lib/launch/sanitize'
import {
  type CampaignPlanContent,
  listSpecClaims,
  type ReleaseSpecContent,
  type SpecSource,
} from '@/lib/launch/spec-schema'
import type { ActiveBrand } from '@/lib/launch/store'
import type { StoredProductProfile } from '@/lib/tenant/product-profile'

/** Registered product and release URLs the agents may capture, in priority order. */
export function captureUrlsFor(urls: Array<string | null | undefined>): string[] {
  const allowed: string[] = []
  for (const url of urls) {
    if (!url || allowed.includes(url)) continue
    try {
      assertPublicCaptureUrl(url)
      allowed.push(url)
    } catch {
      // Private or malformed URLs are skipped, never captured.
    }
  }
  return allowed.slice(0, 5)
}

const line = (label: string, value: unknown) => {
  if (value === null || value === undefined || value === '') return null
  const text = Array.isArray(value) ? value.join(', ') : String(value)
  return text.trim() ? `${label}: ${defuseMarkup(text.trim())}` : null
}

export function formatBrandKit(kit: BrandKitValues | null): string | null {
  if (!kit) return null
  return [
    `<brand_kit name="${defuseMarkup(kit.name).replace(/"/g, '')}">`,
    `Background ${kit.background}, foreground (text) ${kit.foreground}, accent ${kit.accent}.`,
    kit.fontFamily
      ? `Typeface ${defuseMarkup(kit.fontFamily)}${brandFontId(kit.fontFamily) ? ` (editor font "${brandFontId(kit.fontFamily)}")` : ' (not in the editor catalog; closest available is used)'}.`
      : null,
    '</brand_kit>',
  ]
    .filter(Boolean)
    .join('\n')
}

/** The confirmed product profile: what the product is, for whom, and what it can claim. */
export function formatProductProfile(profile: StoredProductProfile | null): string | null {
  if (!profile) return null
  return [
    '<product_profile>',
    line('Name', profile.name),
    line('URL', profile.url),
    line('Summary', profile.summary),
    line('Problem', profile.problem),
    line('Audience', profile.audience),
    line('Capabilities', profile.capabilities),
    line(
      'Proof points',
      profile.proofPoints.map((point) => point.claim)
    ),
    line('Pricing', profile.pricingNote),
    line('Alternatives', profile.competitors),
    '</product_profile>',
  ]
    .filter(Boolean)
    .join('\n')
}

export function prohibitedTermsOf(brand: ActiveBrand): string[] {
  return prohibitedTermList(brand.profile?.prohibitedTerms)
}

/** The spec as the downstream stages see it: claims with refs, plus open questions as unknowns. */
export function formatSpecForStages(spec: ReleaseSpecContent, version: number): string {
  const claims = listSpecClaims(spec)
    .map((claim) => `- ${claim.ref}: ${defuseMarkup(claim.text)}`)
    .join('\n')
  const unknowns = spec.openQuestions
    .filter((question) => !question.answer)
    .map((question) => `- ${defuseMarkup(question.question)}`)
    .join('\n')
  return [
    `<spec version="${version}">`,
    `Summary: ${defuseMarkup(spec.summary.text)}`,
    `Calls to action: ${spec.messaging.ctas.map(defuseMarkup).join(' | ') || 'none given'}`,
    `Alternatives people use today: ${spec.messaging.positioning.alternatives.map(defuseMarkup).join(', ') || 'none given'}`,
    `Claims (cite these refs):\n${claims}`,
    unknowns ? `Unknowns (do not state these as facts):\n${unknowns}` : null,
    '</spec>',
  ]
    .filter(Boolean)
    .join('\n')
}

export function formatPlanForStages(plan: CampaignPlanContent, version: number): string {
  return `<plan version="${version}">\n${JSON.stringify(plan, null, 1)}\n</plan>`
}

/**
 * Registered capture URLs, each with the page sections a capture can scroll
 * to (url#id), so the plan can point every asset at the screen that proves it.
 */
export function formatCaptureTargets(captureUrls: string[], sources: SpecSource[]): string {
  if (captureUrls.length === 0) {
    return '<capture_urls>\nNone registered: leave capture hint urls empty.\n</capture_urls>'
  }
  const lines = captureUrls.flatMap((url) => {
    const sections = sources.find((source) => source.url === url)?.sections ?? []
    return [
      url,
      ...sections
        .slice(0, 25)
        .map((section) => `  ${url}#${section.id} — ${defuseMarkup(section.title)}`),
    ]
  })
  return `<capture_urls>\n${lines.join('\n')}\n</capture_urls>`
}

import type { Metadata } from 'next'
import { z } from 'zod'
import { planPriceSummary } from '@/lib/billing/plans'
import { OG_DEFAULTS } from '@/lib/seo/metadata'

/**
 * Public marketing pages for the platform. One registry feeds page metadata,
 * the navigation and footer, the sitemap, and the Markdown alternates agents
 * read, so a page added here shows up everywhere at once.
 */

/** Every platform marketing route. */
export const platformPagePathSchema = z.enum([
  '/pricing',
  '/product',
  '/product/launch-intelligence',
  '/product/creative-engine',
  '/product/approvals',
  '/product/publishing',
  '/product/release-intake',
  '/product/guardrails',
  '/use-cases',
  '/use-cases/feature-launches',
  '/use-cases/product-launches',
  '/use-cases/changelog-and-email',
  '/solutions/founders',
  '/solutions/product-marketing',
  '/solutions/developer-tools',
  '/integrations',
  '/security',
  '/enterprise',
  '/roadmap',
  '/design-partners',
  '/principles',
])

/** A platform marketing route. */
export type PlatformPagePath = z.infer<typeof platformPagePathSchema>

/** Menu a page belongs to in the navigation. */
export const navGroupSchema = z.enum(['product', 'solutions', 'developers', 'company'])

/** Menu a page belongs to in the navigation. */
export type NavGroup = z.infer<typeof navGroupSchema>

/** Everything the site needs to know about one platform page. */
export type PlatformPage = {
  /** Browser title. The root layout appends the brand. */
  title: string
  /** Meta and Open Graph description. */
  description: string
  /** Short label for menus and cards. */
  label: string
  /** One line under the label in menus and cards. */
  blurb: string
  /** Navigation menu, or null for pages reached another way. */
  group: NavGroup | null
  /** Markdown alternate summary for agents. */
  summary: string
  /** Markdown alternate bullet points for agents. */
  points?: string[]
}

const P = platformPagePathSchema.enum
const G = navGroupSchema.enum

/** The registry itself, in menu order within each group. */
export const PLATFORM_PAGES: Record<PlatformPagePath, PlatformPage> = {
  [P['/product']]: {
    title: 'Product: from release to launch in one workspace',
    description:
      'Shots turns a release into a cited launch brief, on-brand visuals, and posts for six channels. A teammate approves every post before it publishes.',
    label: 'Overview',
    blurb: 'How the parts fit together',
    group: G.product,
    summary:
      'Overview of the Shots platform. Six parts turn a release into a reviewed, scheduled launch: release intake, launch intelligence, the creative engine, approvals, publishing, and guardrails.',
  },
  [P['/product/launch-intelligence']]: {
    title: 'Launch intelligence: cited launch briefs, plans, and posts',
    description:
      'Launch intelligence turns a release into a launch brief where every claim cites a source. It then plans the launch and drafts visuals and posts, and you approve each stage.',
    label: 'Launch intelligence',
    blurb: 'Cited launch brief, plan, visuals, and posts',
    group: G.product,
    summary:
      'Launch intelligence reads a release and its sources, drafts a cited launch brief, plans the launch, produces on-brand visuals and channel posts, and proposes revisions a reviewer applies or discards. Claims without a source become open questions.',
    points: [
      'Eleven launch brief sections, each claim citing the release or a numbered source',
      'Plans with channel roles, angles, visual capture hints, and a teaser, launch day, and follow-up timeline',
      'Copy checks for channel limits, hype terms, banned terms, unknown links, and uncited claims',
      'Revisions arrive as proposals with word diffs; nothing changes until applied',
      'Team preferences looked up from the workspace history each time the AI writes',
    ],
  },
  [P['/product/creative-engine']]: {
    title: 'Creative engine: real screenshots, framed on brand',
    description:
      'The open-source Shots editor makes every launch visual. It captures your live product, frames it on brand, and saves layers you can edit by hand.',
    label: 'Creative engine',
    blurb: 'The editor makes every visual',
    group: G.product,
    summary:
      'The creative engine is the Shots editor used to make launch visuals. The AI captures product pages and source pages, frames them in device and browser mockups with the brand kit, and saves editor files that open for manual changes.',
  },
  [P['/product/approvals']]: {
    title: 'Approvals: a teammate signs off on every post',
    description:
      "Every post needs a signed-in teammate's approval, enforced on the server with six fixed roles. API keys and the AI can draft but can't approve, and you can approve a whole launch in one click.",
    label: 'Approvals',
    blurb: 'Nothing ships without a teammate',
    group: G.product,
    summary:
      'Launch posts move through DRAFT, READY_FOR_REVIEW, APPROVED or NEEDS_CHANGES or REJECTED, then SCHEDULED and PUBLISHED. Only signed-in teammates with the release:approve permission can approve, and a solo founder can approve their own posts. Batch approval is atomic and audited once.',
  },
  [P['/product/publishing']]: {
    title: 'Publishing: scheduled posts that go out once',
    description:
      'Approved posts are checked again at send time and marked published only when the network confirms them. Release emails go to subscribers who opted in, with one-click unsubscribe.',
    label: 'Publishing',
    blurb: 'Scheduled, confirmed delivery',
    group: G.product,
    summary:
      'Publishing schedules approved posts on Temporal workflows that survive restarts. Each post is checked again at send time, retried safely on rate limits, and marked published only when the network confirms it. Uncertain deliveries are held for a teammate. Social channels are in early access.',
  },
  [P['/product/release-intake']]: {
    title: 'Release intake: REST API, webhooks, and the release form',
    description:
      'Send releases from CI, a deploy hook, or a signed GitHub, GitLab, or custom webhook. Scoped API keys and idempotency keys keep retries safe, and the API ships an OpenAPI 3.1 spec.',
    label: 'Release intake',
    blurb: 'API, webhooks, and the form',
    group: G.developers,
    summary:
      'Releases enter through the release form, the GitHub App, POST /api/v1/releases with an X-API-Key and an Idempotency-Key, or signed GitHub, GitLab, and generic webhooks to /api/webhooks/source/{sourceAppId}. Keys carry one of five scopes and cannot approve or publish.',
  },
  [P['/product/guardrails']]: {
    title: 'Guardrails: how sources stay evidence',
    description:
      "A web page can't take over the AI. Shots cleans and labels every source, fetches public addresses only, enforces citations, and runs copy checks on every post.",
    label: 'Guardrails',
    blurb: 'How sources stay evidence',
    group: G.product,
    summary:
      'Release sources are cleaned, labeled as untrusted, and flagged for instruction-like text before the AI reads them. Fetching reaches public addresses only, citations are checked after generation, copy checks run on every post, and every AI action is metered and audited.',
  },
  [P['/use-cases']]: {
    title: 'Use cases: launches, features, changelogs, and email',
    description:
      'Teams use Shots to announce shipped features, plan product launches, and turn release notes into a changelog entry and a release email.',
    label: 'All use cases',
    blurb: 'What teams launch with it',
    group: G.solutions,
    summary:
      'Use cases for Shots: announcing a shipped feature, planning a product launch across teaser, launch day, and follow-up, and turning release notes into a changelog entry and a release email.',
  },
  [P['/use-cases/feature-launches']]: {
    title: 'Feature launches: announce what you shipped the same day',
    description:
      'Turn a merged feature into a cited launch brief, real screenshots, and posts for X, LinkedIn, Instagram, Product Hunt, your changelog, and email. Approve them all in one click.',
    label: 'Feature launches',
    blurb: 'Ship it, then say so',
    group: G.solutions,
    summary:
      'Feature launches with Shots: describe the release or send it from GitHub, review the cited launch brief, approve a plan, and approve channel posts with real product screenshots in one batch.',
  },
  [P['/use-cases/product-launches']]: {
    title: 'Product launches: teaser, launch day, and follow-up',
    description:
      'Plan a product launch as a timeline with a teaser, launch day, and follow-up. Shots makes visuals in every format and keeps Product Hunt copy inside its limits.',
    label: 'Product launches',
    blurb: 'Plan the whole launch week',
    group: G.solutions,
    summary:
      'Product launches with Shots: a plan split into teaser, launch day, and follow-up, hero and feature visuals in 16:9, 1:1, 4:5, and 9:16, and channel copy checked against each channel limit.',
  },
  [P['/use-cases/changelog-and-email']]: {
    title: 'Changelog and email: release notes people read',
    description:
      'Turn every release into a changelog entry and a release email. The email goes only to subscribers who opted in, with one-click unsubscribe and one delivery per address.',
    label: 'Changelog and email',
    blurb: 'Release notes that land',
    group: G.solutions,
    summary:
      'Shots drafts a changelog entry and a release email for each release. Release email goes only to subscribers who opted in, honors per-workspace unsubscribe and suppression, and delivers exactly once per address.',
  },
  [P['/solutions/founders']]: {
    title: 'For founders: marketing that ships when you do',
    description:
      "You build the product and review the pull requests. Shots drafts the launch from your release, so marketing doesn't wait for a free afternoon.",
    label: 'Founders',
    blurb: 'For teams of one to ten',
    group: G.solutions,
    summary:
      'Shots for founders: the release you already wrote becomes a cited launch brief, real screenshots, and channel posts. You can approve your own posts, the editor is included in every plan, and nothing publishes without you.',
  },
  [P['/solutions/product-marketing']]: {
    title: 'For product marketing: one cited launch brief per release',
    description:
      'Shots gives product marketing a cited launch brief for every release and plans you approve. Writers, approvers, and publishers get separate roles, and every revision shows a diff.',
    label: 'Product marketing',
    blurb: 'A cited launch brief per release',
    group: G.solutions,
    summary:
      'Shots for product marketing teams: a versioned, cited launch brief, approved launch plans, separate creator, approver, and publisher roles, brand kits on every visual, and an audit trail of every decision.',
  },
  [P['/solutions/developer-tools']]: {
    title: 'For developer tools: launches your users can check',
    description:
      'For teams whose users read code. Releases arrive from CI or GitHub webhooks, claims cite the pull request, and the docs come in formats AI tools can read.',
    label: 'Developer tools',
    blurb: 'For products developers use',
    group: G.solutions,
    summary:
      'Shots for developer tool companies: releases from CI or GitHub and GitLab webhooks, launch briefs that cite the pull request, code-to-image rendering, changelog copy, and llms.txt and Markdown pages for AI tools.',
  },
  [P['/integrations']]: {
    title: 'Integrations: GitHub, GitLab, social, email, and SIEM',
    description:
      'Shots takes releases from GitHub, GitLab, and the REST API. It publishes to X, LinkedIn, Instagram, and email, and exports audit logs to Splunk and Datadog.',
    label: 'Integrations',
    blurb: 'Where it connects',
    group: G.developers,
    summary:
      'Shots integrations, each marked available, early access, or planned: release intake from the GitHub App, GitHub and GitLab webhooks, generic webhooks, and the REST API; publishing to X, LinkedIn, and Instagram; release email; Google, GitHub, and Microsoft sign-in with SAML and OIDC SSO; and audit log export to Splunk, Datadog, and any HTTPS endpoint.',
  },
  [P['/security']]: {
    title: 'Security: every control, written down',
    description:
      'How Shots protects your workspace, from SSO and six fixed roles to an append-only audit log and private storage. The page also covers AI safeguards and the providers we run on.',
    label: 'Security',
    blurb: 'Controls, data, and providers',
    group: G.company,
    summary:
      'Security at Shots: Better Auth organizations with six roles, SAML and OIDC SSO, SCIM user provisioning, TOTP two-factor, an append-only audit log with hashed IPs, signed audit log export to SIEM tools, 90-day default retention with legal hold, private storage for each workspace, and AI inputs treated as untrusted. Hosting is in the United States.',
  },
  [P['/enterprise']]: {
    title: 'Enterprise: SSO, SCIM, audit log export, and legal hold',
    description:
      'Shots Enterprise adds SAML and OIDC single sign-on, SCIM user provisioning, and audit log export to Splunk and Datadog. It also adds longer retention, legal hold, the highest limits, and self-hosting.',
    label: 'Enterprise',
    blurb: 'For security reviews',
    group: G.company,
    summary:
      'Shots Enterprise adds SAML and OIDC SSO, SCIM user provisioning, signed audit log export to Splunk, Datadog, or any HTTPS endpoint, longer audit retention, legal hold, and the highest workspace quotas. The platform can also be self-hosted with Docker and Helm.',
  },
  [P['/pricing']]: {
    title: 'Pricing: Pro, Business, and Enterprise',
    description:
      'Shots has three paid plans: Pro, Business, and Enterprise. Each plan sets monthly AI credits, scheduled posts, and release emails, plus API writes per minute, concurrent jobs, and storage.',
    label: 'Pricing',
    blurb: 'Plans and limits',
    group: null,
    summary:
      `Shots workspace plans: Pro (${planPriceSummary('pro')}), Business (${planPriceSummary('business')}), and Enterprise (${planPriceSummary('enterprise')}), with monthly AI credit, API write, concurrent job, and storage limits. There is no free plan. The image editor, media and advanced queues are included in every plan. Launch intelligence is in early access for design partners.`,
  },
  [P['/roadmap']]: {
    title: 'Roadmap: what ships now and what comes next',
    description:
      'The public Shots roadmap shows what has shipped and what comes next, from URL onboarding to demo videos, the weekly plan, and automation modes.',
    label: 'Roadmap',
    blurb: 'Shipped, next, and later',
    group: G.company,
    summary: 'The Shots roadmap, grouped as shipped, next, and later.',
  },
  [P['/design-partners']]: {
    title: 'Design partners: shape the launch platform',
    description:
      'Join the Shots design partner program. You get early access to launch intelligence, a direct line to the team, and a say in what ships next.',
    label: 'Design partners',
    blurb: 'Early access program',
    group: G.company,
    summary:
      'The Shots design partner program gives teams that ship every week early access to launch intelligence and a direct line to the builders, in exchange for real releases and honest feedback.',
  },
  [P['/principles']]: {
    title: 'Principles: how we build',
    description:
      'The rules behind Shots: manual tools before the AI, fixed steps before automation, the workspace over chat, enforced approval, and cite or ask.',
    label: 'Principles',
    blurb: 'How we build it',
    group: G.company,
    summary:
      'The design principles behind Shots: keep the promise narrow, build the manual tools first, fixed steps before the AI, the workspace over chat, enforced approval, cite or ask, and always leave something useful.',
  },
}

/** Pages in a navigation group, in registry order. */
export function pagesInGroup(group: NavGroup): { path: PlatformPagePath; page: PlatformPage }[] {
  return platformPagePathSchema.options
    .filter((path) => PLATFORM_PAGES[path].group === group)
    .map((path) => ({ path, page: PLATFORM_PAGES[path] }))
}

/** Next.js metadata for a platform page, with canonical URL and Open Graph. */
export function platformMetadata(path: PlatformPagePath): Metadata {
  const { description, title } = PLATFORM_PAGES[path]
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { ...OG_DEFAULTS, title: `${title} | Shots`, description, url: path },
  }
}

/** Markdown alternates for agents, one per platform page, in registry order. */
export function platformAgentPages(): {
  path: PlatformPagePath
  title: string
  summary: string
  points?: string[]
}[] {
  return platformPagePathSchema.options.map((path) => {
    const { points, summary, title } = PLATFORM_PAGES[path]
    return { path, title: `${title} - Shots`, summary, points }
  })
}

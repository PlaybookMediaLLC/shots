import { z } from 'zod'

/**
 * Workspace plans. There is no free plan: `free` is the state of a workspace
 * without a subscription, which keeps its owner's seat and grants nothing else.
 */
export const workspacePlanSchema = z.enum(['free', 'pro', 'business', 'enterprise'])
export type WorkspacePlan = z.infer<typeof workspacePlanSchema>

/** Plans a workspace can buy without talking to sales. */
export const checkoutPlanSchema = workspacePlanSchema.extract(['pro', 'business'])

/** How often a self-serve plan is billed. */
export const billingIntervalSchema = z.enum(['monthly', 'annual'])

/** One-time AI credit packs a workspace can buy on a paid plan. */
export const creditPackSchema = z.enum(['launch'])

/**
 * What each pack adds and costs. Pack credits are spent after the monthly
 * allowance and do not expire (docs/rfcs/023-pricing-and-unit-economics.md).
 */
export const CREDIT_PACKS: Record<
  z.infer<typeof creditPackSchema>,
  { credits: number; price: string }
> = {
  launch: { credits: 500, price: '$12' },
}

/**
 * Credits a launch uses on the default models: an estimate in
 * docs/rfcs/023-pricing-and-unit-economics.md until measured. Copy reads it here.
 */
export const LAUNCH_CREDITS = 20

/**
 * List prices in whole US dollars a month: every price on the site, in the
 * agent docs and in structured data is derived from these. Stripe holds the
 * charged amounts, so a change here needs new Stripe prices
 * (docs/rfcs/023-pricing-and-unit-economics.md#stripe-cutover-for-the-2026-10-29-prices).
 * Enterprise is the lowest sales-led price, billed annually.
 */
export const PLAN_PRICES: Record<Exclude<WorkspacePlan, 'free'>, number> = {
  pro: 29,
  business: 79,
  enterprise: 799,
}

/** Annual billing takes this share off the monthly price. */
export const ANNUAL_DISCOUNT = 0.15

/** A self-serve plan's monthly price when billed annually, in whole dollars. */
export function annualMonthlyPrice(plan: z.infer<typeof checkoutPlanSchema>): number {
  return Math.round(PLAN_PRICES[plan] * (1 - ANNUAL_DISCOUNT))
}

/** 999 → "$999". */
export function usd(dollars: number): string {
  return `$${dollars.toLocaleString('en-US')}`
}

/** "$39/mo, or $33/mo billed annually"; Enterprise reads "from $999/mo, billed annually". */
export function planPriceSummary(plan: Exclude<WorkspacePlan, 'free'>): string {
  const checkout = checkoutPlanSchema.safeParse(plan)
  return checkout.success
    ? `${usd(PLAN_PRICES[plan])}/mo, or ${usd(annualMonthlyPrice(checkout.data))}/mo billed annually`
    : `from ${usd(PLAN_PRICES[plan])}/mo, billed annually`
}

export const workspaceFeatureSchema = z.enum([
  'asset:create',
  'asset:read',
  'asset:update',
  'asset:delete',
  'release:create',
  'source-app:create',
  // Using the product at all: the editor, the tools, and the API.
  'workspace:use',
  'workspace:paid',
  'content:scheduling-advanced',
  'enterprise:audit-drain',
  'enterprise:sso',
  'enterprise:scim',
  // The organization's own name, logo and colors in the app.
  'enterprise:white-label',
  // The campaign workflow. Every paid plan includes it; featureOverrides can
  // still grant or revoke it per workspace.
  'campaign:workflow',
  // Hand-written content drafts scheduled to channels (RFC 013).
  'content:drafts',
  // The onboarding agent (docs/rfcs/032). Every paid plan includes it;
  // PLATFORM_ONBOARDING_AGENT in the backend can limit or disable it.
  'onboarding:agent',
])
export type WorkspaceFeature = z.infer<typeof workspaceFeatureSchema>

/**
 * Metered workspace quotas. The monthly ones reset at the start of each UTC
 * calendar month and are metered in the Go backend's Redis store. One AI
 * credit is $0.01 of model spend at list price (docs/rfcs/035).
 */
export const workspaceQuotaSchema = z.enum([
  'api:write:minute',
  'storage:bytes',
  'ai:credits:monthly',
  'posts:monthly',
  'emails:monthly',
  'jobs:concurrent',
])
export type WorkspaceQuota = z.infer<typeof workspaceQuotaSchema>

/** Caps on what a workspace holds, rather than on what it uses each month. */
export const workspaceLimitSchema = z.enum(['seats', 'channels'])
export type WorkspaceLimit = z.infer<typeof workspaceLimitSchema>

export const featureOverrideSchema = z
  .partialRecord(workspaceFeatureSchema, z.boolean())
  .default({})

const planFeatures = {
  free: [],
  pro: [
    'asset:create',
    'asset:read',
    'asset:update',
    'asset:delete',
    'release:create',
    'source-app:create',
    'workspace:use',
    'workspace:paid',
    'content:scheduling-advanced',
    'campaign:workflow',
    'content:drafts',
    'onboarding:agent',
  ],
  business: [
    'asset:create',
    'asset:read',
    'asset:update',
    'asset:delete',
    'release:create',
    'source-app:create',
    'workspace:use',
    'workspace:paid',
    'content:scheduling-advanced',
    'campaign:workflow',
    'content:drafts',
    'onboarding:agent',
  ],
  enterprise: [
    'asset:create',
    'asset:read',
    'asset:update',
    'asset:delete',
    'release:create',
    'source-app:create',
    'workspace:use',
    'workspace:paid',
    'content:scheduling-advanced',
    'enterprise:audit-drain',
    'enterprise:sso',
    'enterprise:scim',
    'enterprise:white-label',
    'campaign:workflow',
    'content:drafts',
    'onboarding:agent',
  ],
} as const satisfies Record<WorkspacePlan, readonly WorkspaceFeature[]>

const minimumPlanByFeature: Record<WorkspaceFeature, WorkspacePlan> = {
  'asset:create': 'pro',
  'asset:read': 'pro',
  'asset:update': 'pro',
  'asset:delete': 'pro',
  'release:create': 'pro',
  'source-app:create': 'pro',
  'workspace:use': 'pro',
  'workspace:paid': 'pro',
  'content:scheduling-advanced': 'pro',
  'enterprise:audit-drain': 'enterprise',
  'enterprise:sso': 'enterprise',
  'enterprise:scim': 'enterprise',
  'enterprise:white-label': 'enterprise',
  'campaign:workflow': 'pro',
  'content:drafts': 'pro',
  'onboarding:agent': 'pro',
}

/** Mirrors `planQuotas` in server/internal/product/quota.go. */
const planQuotas = {
  free: {
    'ai:credits:monthly': 0,
    'api:write:minute': 0,
    'emails:monthly': 0,
    'jobs:concurrent': 0,
    'posts:monthly': 0,
    'storage:bytes': 0,
  },
  pro: {
    'ai:credits:monthly': 600,
    'api:write:minute': 300,
    'emails:monthly': 5_000,
    'jobs:concurrent': 5,
    'posts:monthly': 250,
    'storage:bytes': 50 * 1024 * 1024 * 1024,
  },
  business: {
    'ai:credits:monthly': 3_000,
    'api:write:minute': 1_500,
    'emails:monthly': 25_000,
    'jobs:concurrent': 25,
    'posts:monthly': 600,
    'storage:bytes': 250 * 1024 * 1024 * 1024,
  },
  enterprise: {
    'ai:credits:monthly': 15_000,
    'api:write:minute': 10_000,
    'emails:monthly': 100_000,
    'jobs:concurrent': 250,
    'posts:monthly': 5_000,
    'storage:bytes': 5 * 1024 * 1024 * 1024 * 1024,
  },
} as const satisfies Record<WorkspacePlan, Record<WorkspaceQuota, number>>

/**
 * Mirrors `planLimits` in server/internal/product/plan_limits.go. `null` is
 * unlimited. A pending invitation holds a seat; only active social channels count.
 */
const planLimits = {
  free: { channels: 0, seats: 1 },
  pro: { channels: 15, seats: 10 },
  business: { channels: 100, seats: null },
  enterprise: { channels: null, seats: null },
} as const satisfies Record<WorkspacePlan, Record<WorkspaceLimit, number | null>>

type WorkspaceEntitlementSnapshot = {
  featureOverrides?: unknown
  plan?: unknown
  status?: string | null
  graceUntil?: Date | null
  validUntil?: Date | null
}

export type WorkspaceFeatureDecision = {
  allowed: boolean
  currentPlan: WorkspacePlan
  requiredPlan: WorkspacePlan
}

export function hasWorkspaceFeature(
  plan: WorkspacePlan,
  feature: WorkspaceFeature,
  overrides: Partial<Record<WorkspaceFeature, boolean>> = {}
): boolean {
  return overrides[feature] ?? planFeatures[plan].includes(feature as never)
}

export function getMinimumPlan(feature: WorkspaceFeature): WorkspacePlan {
  return minimumPlanByFeature[feature]
}

export function evaluateWorkspaceFeature(
  entitlement: WorkspaceEntitlementSnapshot | null,
  feature: WorkspaceFeature,
  now = new Date()
): WorkspaceFeatureDecision {
  const parsedPlan = workspacePlanSchema.safeParse(entitlement?.plan)
  const currentPlan = parsedPlan.success ? parsedPlan.data : 'free'
  const overrides = featureOverrideSchema.catch({}).parse(entitlement?.featureOverrides)
  const isCurrent = !entitlement?.validUntil || entitlement.validUntil > now
  const isInBillingGrace =
    entitlement?.status === 'past_due' && !!entitlement.graceUntil && entitlement.graceUntil > now
  const isActive = entitlement
    ? parsedPlan.success &&
      (entitlement.status === 'active' || entitlement.status === 'trialing' || isInBillingGrace) &&
      isCurrent
    : true

  return {
    allowed: isActive && hasWorkspaceFeature(currentPlan, feature, overrides),
    currentPlan,
    requiredPlan: getMinimumPlan(feature),
  }
}

export function getWorkspaceQuota(plan: WorkspacePlan, quota: WorkspaceQuota): number {
  return planQuotas[plan][quota]
}

/** How many of `limit` a plan's workspace may hold; `null` is unlimited. */
export function getWorkspaceLimit(plan: WorkspacePlan, limit: WorkspaceLimit): number | null {
  return planLimits[plan][limit]
}

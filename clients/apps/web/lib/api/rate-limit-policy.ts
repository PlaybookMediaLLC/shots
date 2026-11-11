/**
 * Rate limit policies, kept free of any Redis import.
 *
 * `lib/rate-limit.ts` pulls in the Redis client, which is `server-only`.
 * Declaring the policies here lets route handlers, tests, and any future
 * edge-side logic reference the limits without dragging a server-only
 * transitive dependency along with them.
 */

import { z } from 'zod'

/** A fixed-window rate limit. */
export const rateLimitPolicySchema = z.object({
  /** Most requests allowed per window. */
  maxRequests: z.int().positive(),
  /** Namespace so different policies never share a counter for the same client. */
  name: z.string().min(1),
  /** Window length in milliseconds. */
  windowMs: z.int().positive(),
})

/** One of {@link rateLimitPolicySchema}. */
export type RateLimitPolicy = z.infer<typeof rateLimitPolicySchema>

/**
 * Screenshot capture is expensive but user-driven, so the window stays
 * generous enough for normal editing sessions.
 */
export const SCREENSHOT_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 20,
  name: 'screenshot',
  windowMs: 60_000,
}

/**
 * Credential endpoints are the credential-stuffing surface. Ten attempts per
 * minute is far above what a human sign-in needs and far below what an
 * automated attack requires to be useful.
 */
export const AUTH_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 10,
  name: 'auth',
  windowMs: 60_000,
}

/** OAuth token requests include replay responses that bypass the provider's own limiter. */
export const OAUTH_TOKEN_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 20,
  name: 'oauth-token',
  windowMs: 60_000,
}

/** Member invitations can trigger transactional email, so this is scoped to
 * the actor and workspace rather than a shared client IP. */
export const WORKSPACE_INVITATION_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 10,
  name: 'workspace-invitation',
  windowMs: 60 * 60 * 1_000,
}

/** Resending an invitation emails the invitee again, so it gets a tighter budget. */
export const WORKSPACE_INVITATION_RESEND_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 3,
  name: 'workspace-invitation-resend',
  windowMs: 60 * 60 * 1_000,
}

/**
 * Design renders per workspace. The render service is shared, so one
 * workspace bursting (an agent run, a directions request) must not crowd out
 * everyone else. Cache hits do not count; only real renders do.
 */
export const DESIGN_RENDER_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 60,
  name: 'design-render',
  windowMs: 60_000,
}

/**
 * Launch pipeline AI actions (spec, plan, produce, revise) per workspace.
 * Each action is also one unit of the monthly generation quota; this keeps a
 * burst of clicks or a script from spending it in seconds.
 */
export const LAUNCH_AI_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 20,
  name: 'launch-ai',
  windowMs: 60_000,
}

/**
 * Link previews fetch an arbitrary public page plus its robots.txt, sitemap,
 * favicon, and images, so each workspace gets a budget that covers a batch
 * check or a CI run but not a crawler.
 */
export const LINK_PREVIEW_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 60,
  name: 'link-preview',
  windowMs: 60_000,
}

/**
 * Comments through a public review link. Reviewers leave a handful of notes;
 * the cap stops a leaked link from being used to flood a workspace.
 */
export const STORE_REVIEW_COMMENT_RATE_LIMIT: RateLimitPolicy = {
  maxRequests: 30,
  name: 'store-review-comment',
  windowMs: 10 * 60_000,
}

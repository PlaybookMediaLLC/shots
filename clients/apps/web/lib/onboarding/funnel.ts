import { z } from 'zod'
import { trackEvent } from '@/lib/analytics'

/**
 * The onboarding funnel (docs/rfcs/034-background-onboarding-agent.md,
 * observability): a URL or manual description submitted, the profile
 * confirmed, and persisted campaign creation or recovery. Readiness requires
 * separate human review; retries do not count as new campaigns.
 */
export const onboardingEventSchema = z.enum([
  'onboarding_product_started',
  'onboarding_profile_confirmed',
  'onboarding_campaign_ready',
  'onboarding_campaign_created',
  'onboarding_campaign_resumed',
  'onboarding_campaign_failed',
])

/** One of {@link onboardingEventSchema}. */
export type OnboardingEvent = z.infer<typeof onboardingEventSchema>

/** Record an onboarding funnel step. Browser only; a no-op elsewhere. */
export function trackOnboarding(
  event: OnboardingEvent,
  data?: Record<string, string | number | boolean>
): void {
  trackEvent(event, data)
}

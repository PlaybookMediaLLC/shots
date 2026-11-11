import { z } from 'zod'

/** Referral program state and accepted invitations returned by the Shots database. */
export const founderHubReferralSummarySchema = z.object({
  enabled: z.boolean(),
  eligible: z.boolean(),
  code: z.string().nullable(),
  accepted: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  months_earned: z.number().int().nonnegative(),
  invites: z.array(
    z.object({
      id: z.uuid(),
      slot: z.number().int(),
      policy: z.enum(['legacy_payment', 'trial_month']),
      accepted_at: z.string().nullable(),
      trial_started_at: z.string().nullable(),
      reward_applied_at: z.string().nullable(),
      extended_until: z.string().nullable(),
      legacy_amount_cents: z.number().int().nullable(),
      status: z.enum(['legacy_applied', 'legacy_pending', 'applied', 'pending', 'applying', 'accepted']),
    })
  ),
})

/** Claim an eligible referral code for the signed-in Shots account. */
export const founderHubReferralClaimSchema = z.object({ code: z.string().regex(/^[a-f0-9]{24}$/) }).strict()
export const founderHubReferralClaimResultSchema = z.object({ claimed: z.boolean() })

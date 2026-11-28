import 'server-only'

import { z } from 'zod'
import { serviceBackend } from '@/lib/backend/sdk'
import {
  featureOverrideSchema,
  workspaceAddonSchema,
  workspacePlanSchema,
} from '@/lib/billing/plans'

export const entitlementSyncSchema = z.object({
  eventId: z.string().min(1).max(255),
  eventType: z.string().min(1).max(120),
  expectedVersion: z.number().int().nonnegative(),
  externalCustomerId: z.string().max(255).nullish(),
  externalSubscriptionId: z.string().max(255).nullish(),
  featureOverrides: featureOverrideSchema,
  graceUntil: z.coerce.date().nullish(),
  organizationId: z.string().min(1),
  plan: workspacePlanSchema,
  provider: z.string().min(1).max(80),
  status: z.enum(['active', 'trialing', 'past_due', 'paused', 'suspended', 'cancelled']),
  validUntil: z.coerce.date().nullish(),
})

export const addonSyncSchema = z.object({
  addonKey: workspaceAddonSchema,
  cancelAtPeriodEnd: z.boolean().default(false),
  currentPeriodEnd: z.coerce.date().nullish(),
  currentPeriodStart: z.coerce.date().nullish(),
  eventId: z.string().min(1).max(255),
  eventType: z.string().min(1).max(120),
  expectedVersion: z.number().int().nonnegative(),
  externalSubscriptionId: z.string().max(255).nullish(),
  graceUntil: z.coerce.date().nullish(),
  organizationId: z.string().min(1),
  provider: z.string().min(1).max(80),
  quotaLimit: z.number().int().nonnegative().nullish(),
  status: z.enum(['active', 'past_due', 'paused', 'canceled']),
})

/**
 * Applies a verified billing event once per provider event ID. The backend
 * rejects a stale `expectedVersion` with 409 and a missing workspace with 404.
 */
export async function syncWorkspaceEntitlement(
  input: z.infer<typeof entitlementSyncSchema>
): Promise<{ replayed: boolean; version: number }> {
  return serviceBackend().syncWorkspaceEntitlement(input)
}

/**
 * Applies a verified billing add-on event once per provider event ID with
 * optimistic version checking.
 */
export async function syncWorkspaceAddon(
  input: z.infer<typeof addonSyncSchema>
): Promise<{ replayed: boolean; version: number }> {
  return serviceBackend().syncWorkspaceAddon(input)
}

/** Adds a paid AI credit pack once per provider reference; a replay grants nothing. */
export async function grantWorkspaceCredits(input: {
  credits: number
  organizationId: string
  provider: string
  reference: string
}): Promise<{ balance: number; replayed: boolean }> {
  return serviceBackend().grantWorkspaceCredits(input)
}

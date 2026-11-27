import 'server-only'

import { after } from 'next/server'
import type { TenantContext } from '@/lib/auth/access'
import { workspaceQuotaSchema } from '@/lib/billing/plans'
import { consumeWorkspaceQuota } from '@/lib/tenant/entitlements'
import { createAiCreditMeter } from './meter'

/**
 * Schedule non-blocking post-response work via Next.js `after()` when inside a
 * request scope. Returns false outside a request scope (e.g. Node unit tests)
 * so callers fall back to awaiting directly.
 */
export function scheduleAfterResponse(task: () => Promise<void>): boolean {
  try {
    after(task)
    return true
  } catch {
    return false
  }
}

/**
 * The server's AI credit meter, charging `ai:credits:monthly` through the Go
 * backend. The model registry charges every call to `aiCreditMeter`; AI
 * actions run inside `withAiCredits`.
 */
const credits = createAiCreditMeter<TenantContext>(
  (tenant, amount) =>
    consumeWorkspaceQuota(tenant, workspaceQuotaSchema.enum['ai:credits:monthly'], amount),
  { scheduleSettlement: scheduleAfterResponse }
)

/** Charges each model call to the workspace whose AI action is running. */
export const aiCreditMeter = credits.meter

/** Runs an AI action against the workspace's AI credits. */
export const withAiCredits = credits.withAiCredits

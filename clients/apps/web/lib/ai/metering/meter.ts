import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModelCallMeter } from '@/lib/ai/models/middleware'
import { settleCredits, splitCredits } from './pricing'

/**
 * Charges model calls to the AI credits of the workspace whose action is
 * running. An action opens a metered scope with `withAiCredits`; every model
 * call inside it is admitted while credits remain and charged what it cost.
 * A model call outside a scope is refused, so no code path spends model money
 * without a workspace paying for it.
 */

/**
 * Takes `amount` credits from a workspace and resolves to what is left. An
 * amount of 0 only reads the balance; with none left it rejects with the
 * backend's quota error.
 */
export type ConsumeCredits<Tenant> = (tenant: Tenant, amount: number) => Promise<number>

type Scope<Tenant> = {
  tenant: Tenant
  /** Credits left as of the last backend reply; other actions may spend more. */
  remaining: number
  /** Spend below one credit, charged with the next call or at settlement. */
  carryUsd: number
  charges: Set<Promise<void>>
}

/** Builds the scope runner and the model meter around one consume function. */
export function createAiCreditMeter<Tenant extends { organizationId: string }>(
  consume: ConsumeCredits<Tenant>,
  options: {
    /** Optional deferred runner (e.g. Next.js `after()`) for post-response credit settlement. */
    scheduleSettlement?: (task: () => Promise<void>) => boolean
  } = {}
) {
  const scopes = new AsyncLocalStorage<Scope<Tenant>>()

  async function charge(scope: Scope<Tenant>, credits: number): Promise<void> {
    if (credits <= 0) return
    scope.remaining -= credits
    try {
      scope.remaining = await consume(scope.tenant, credits)
    } catch (error) {
      // The backend records a charge that crosses the limit, and fails closed
      // when its meter is down; either way the next call is refused.
      scope.remaining = 0
      if (error instanceof Error && error.name === 'WorkspaceQuotaError') return
      console.error('AI credit charge failed.', {
        credits,
        organizationId: scope.tenant.organizationId,
        reason: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  function record(scope: Scope<Tenant>, costUsd: number): Promise<void> {
    if (!(costUsd > 0)) return Promise.resolve()
    const { credits, carryUsd } = splitCredits(scope.carryUsd + costUsd)
    scope.carryUsd = carryUsd
    const pending = charge(scope, credits)
    scope.charges.add(pending)
    return pending.finally(() => scope.charges.delete(pending))
  }

  /**
   * Runs an AI action against the workspace's AI credits. Refuses to start
   * when none are left, and settles the sub-credit remainder when the action
   * ends, rounded up.
   */
  async function withAiCredits<T>(tenant: Tenant, run: () => Promise<T>): Promise<T> {
    const scope: Scope<Tenant> = {
      carryUsd: 0,
      charges: new Set(),
      remaining: await consume(tenant, 0),
      tenant,
    }
    try {
      return await scopes.run(scope, run)
    } finally {
      const settle = async () => {
        await Promise.all(scope.charges)
        const credits = settleCredits(scope.carryUsd)
        scope.carryUsd = 0
        await charge(scope, credits)
      }
      if (!options.scheduleSettlement?.(settle)) {
        await settle()
      }
    }
  }

  const meter: ModelCallMeter = {
    async admit() {
      const scope = scopes.getStore()
      if (!scope) throw new Error('A model call ran outside a metered AI action.')
      // Wait for in-flight charges, then ask the backend, which rejects with
      // the quota error, limit, and reset time once nothing is left.
      if (scope.remaining <= 0) {
        await Promise.all(scope.charges)
        scope.remaining = await consume(scope.tenant, 0)
      }
      return (costUsd) => record(scope, costUsd)
    },
  }

  return { meter, withAiCredits }
}

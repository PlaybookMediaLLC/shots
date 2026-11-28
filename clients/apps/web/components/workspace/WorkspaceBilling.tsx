'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Group, Row } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useTRPC } from '@/lib/trpc/react'
import { AnnualBillingBanner } from './billing/AnnualBillingBanner'
import { ApiAccessCard } from './billing/ApiAccessCard'
import { BillingFooterActions } from './billing/BillingFooterActions'
import { CurrentPlanCard } from './billing/CurrentPlanCard'
import { UsageAndCreditsCard } from './billing/UsageAndCreditsCard'
import { XLinksAddonCard } from './billing/XLinksAddonCard'
import { getErrorMessage } from './settings-client'

/** Return-trip banners keyed by query param outcomes. */
const CREDIT_OUTCOMES: Record<string, string> = {
  cancelled: 'The credit purchase was cancelled. You have not been charged.',
  success: 'Payment received. Your extra launch credits are on the way.',
}

const X_LINKS_OUTCOMES: Record<string, string> = {
  cancelled: 'Links in X posts checkout was cancelled. You have not been charged.',
  enabled: 'Links in X posts is now active. Your workspace can include links in X posts.',
  pending:
    'Payment for Links in X posts is confirming. Refresh in a moment once Stripe completes activation.',
}

/**
 * Workspace billing page: annual upgrade offer, Current Plan card with self-serve
 * lifecycle controls, API Access card, Links in X posts add-on card, monthly
 * allowances/credits, and Stripe Billing Portal + Request Refund footer.
 */
export function WorkspaceBilling({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const creditOutcome = searchParams.get('credits')
  const xLinksOutcome = searchParams.get('x_links')

  const summaryQuery = useQuery(trpc.billing.summary.queryOptions())
  const summary = summaryQuery.data ?? null

  const shouldLoadSubscription = Boolean(
    summary &&
      (summary.paid ||
        summary.status === 'paused' ||
        summary.addons.xLinks.status !== 'off')
  )
  const subscriptionQuery = useQuery(
    trpc.billing.subscription.queryOptions(undefined, {
      enabled: shouldLoadSubscription,
      retry: false,
      staleTime: 30_000,
    })
  )
  const subscription = subscriptionQuery.data ?? null

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.billing.summary.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.billing.subscription.queryKey() })
    void queryClient.invalidateQueries({ queryKey: trpc.billing.xLinksAddon.queryKey() })
  }

  if (summary === null) {
    return (
      <Group>
        <Row>
          <p className="text-sm text-muted-foreground">
            {summaryQuery.error ? getErrorMessage(summaryQuery.error) : 'Loading billing…'}
          </p>
        </Row>
      </Group>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {creditOutcome && CREDIT_OUTCOMES[creditOutcome] ? (
        <Alert>
          <AlertDescription>{CREDIT_OUTCOMES[creditOutcome]}</AlertDescription>
        </Alert>
      ) : null}
      {xLinksOutcome && X_LINKS_OUTCOMES[xLinksOutcome] ? (
        <Alert>
          <AlertDescription>{X_LINKS_OUTCOMES[xLinksOutcome]}</AlertDescription>
        </Alert>
      ) : null}

      {canManage ? (
        <AnnualBillingBanner
          onSwitched={reload}
          plan={summary.plan}
          subscription={subscription}
        />
      ) : null}

      <CurrentPlanCard
        canManage={canManage}
        onChanged={reload}
        onRetrySubscription={() => void subscriptionQuery.refetch()}
        subscription={subscription}
        subscriptionError={
          subscriptionQuery.error ? getErrorMessage(subscriptionQuery.error) : null
        }
        subscriptionLoading={subscriptionQuery.isFetching}
        summary={summary}
      />

      <ApiAccessCard included={summary.apiAccess.included} />

      <XLinksAddonCard
        canManage={canManage}
        onChanged={reload}
        paid={summary.paid}
        xLinks={summary.addons.xLinks}
      />

      <UsageAndCreditsCard canManage={canManage} summary={summary} />

      <BillingFooterActions
        canManage={canManage}
        hasStripeSubscription={Boolean(subscription?.hasStripeCustomer ?? subscription?.cycle)}
      />
    </div>
  )
}

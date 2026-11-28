import type { PillTone } from '@/components/platform-ui'
import type { useTRPCClient } from '@/lib/trpc/react'

export type BillingSubscription = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['billing']['subscription']['query']>
>

export type BillingSummary = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['billing']['summary']['query']>
>

export type BillingInvoice = Awaited<
  ReturnType<ReturnType<typeof useTRPCClient>['billing']['recentInvoices']['query']>
>['invoices'][number]

export const PLAN_TITLES: Record<string, string> = {
  business: 'Business Plan',
  enterprise: 'Enterprise Plan',
  free: 'No active plan',
  pro: 'Pro Plan',
}

export const BILLING_STATUS: Record<string, { label: string; tone: PillTone }> = {
  active: { label: 'Active', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  past_due: { label: 'Past due', tone: 'yellow' },
  paused: { label: 'Paused', tone: 'yellow' },
  suspended: { label: 'Suspended', tone: 'red' },
  trialing: { label: 'Trial', tone: 'blue' },
}

export function formatBillingDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { hasXLinks } from '@/lib/content-drafts/x-links'
import { useTRPC } from '@/lib/trpc/react'

/**
 * Calm inline notice shown in the X preview panel when a draft contains URLs
 * and the workspace either has Links in X posts turned off (default) or has
 * exhausted its rolling 30-day allowance.
 */
export function XLinksPreviewNotice({ captions }: { captions: readonly string[] }) {
  const trpc = useTRPC()
  const containsLink = captions.some((caption) => hasXLinks(caption))
  const { data: status } = useQuery(
    trpc.billing.xLinksAddon.queryOptions(undefined, {
      enabled: containsLink,
      retry: false,
      staleTime: 60_000,
    })
  )

  if (!containsLink || !status) return null
  if (status.enabled && (status.limit === null || (status.remaining ?? 0) > 0)) return null

  if (status.enabled && status.remaining === 0) {
    return (
      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
        Your workspace has used all {status.limit ?? 40} X link posts in the last {status.windowDays}{' '}
        days.
        {status.nextSlotAt
          ? ` Next slot opens ${new Date(status.nextSlotAt).toLocaleDateString()}.`
          : ''}{' '}
        Remove the link or wait for a slot to open.
      </p>
    )
  }

  return (
    <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
      Links are removed from X posts by default.{' '}
      <Link className="font-medium underline underline-offset-4" href="/settings/billing#x-links">
        Turn on Links in X posts (${status.priceMonthlyUsd}/month)
      </Link>{' '}
      in Billing to keep them in.
    </p>
  )
}

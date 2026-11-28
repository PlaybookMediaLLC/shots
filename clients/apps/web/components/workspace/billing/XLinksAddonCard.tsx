'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { LinkIcon } from '@/components/platform-shell/icons'
import { Pill, type PillTone } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { SegmentedMeter } from '@/components/settings/SegmentedMeter'
import { Button } from '@/components/ui/button'
import {
  disableXLinksAddonContract,
  enableXLinksAddonContract,
} from '@/lib/api/contracts/billing'
import { usd } from '@/lib/billing/plans'
import { getErrorMessage, requestJson } from '../settings-client'
import { type BillingSummary, formatBillingDate } from './types'

/**
 * Paid add-on card controlling whether links are preserved on outbound X posts
 * ($10/month for 40 link posts per rolling 30 days) or stripped by default.
 */
export function XLinksAddonCard({
  canManage,
  onChanged,
  paid,
  xLinks,
}: {
  canManage: boolean
  onChanged: () => void
  paid: boolean
  xLinks: BillingSummary['addons']['xLinks']
}) {
  const [enableOpen, setEnableOpen] = useState(false)
  const [disableOpen, setDisableOpen] = useState(false)

  const exhausted = xLinks.enabled && xLinks.limit !== null && (xLinks.remaining ?? 0) === 0
  const priceLabel = `${usd(xLinks.priceMonthlyUsd)}/month`
  const limitLabel =
    xLinks.limit === null
      ? 'unlimited link posts'
      : `${xLinks.limit} link posts every ${xLinks.windowDays} days`

  const pill: { label: string; tone: PillTone } =
    xLinks.status === 'canceling'
      ? { label: 'Cancels soon', tone: 'yellow' }
      : xLinks.status === 'paused'
        ? { label: 'Paused', tone: 'gray' }
        : xLinks.status === 'past_due'
          ? { label: 'Past due', tone: 'yellow' }
          : exhausted
            ? { label: 'Limit reached', tone: 'yellow' }
            : xLinks.enabled
              ? { label: 'On', tone: 'green' }
              : { label: 'Off', tone: 'gray' }

  const handleEnable = async (): Promise<string | null> => {
    try {
      const result = await requestJson(
        enableXLinksAddonContract.path,
        enableXLinksAddonContract.output,
        { body: {}, method: 'POST' }
      )
      if (result.url) {
        window.location.assign(result.url)
        return null
      }
      toast.success('Links in X posts is turned on.')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const handleDisable = async (): Promise<string | null> => {
    try {
      await requestJson(
        disableXLinksAddonContract.path,
        disableXLinksAddonContract.output,
        { body: { immediate: false }, method: 'DELETE' }
      )
      toast.success('Links in X posts will turn off at the end of the billing period.')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const canTurnOff = xLinks.enabled || xLinks.status === 'active' || xLinks.status === 'past_due'

  return (
    <div
      className="flex flex-col gap-4 rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))] p-5 sm:flex-row sm:items-center sm:justify-between"
      id="x-links"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <LinkIcon className="shrink-0 text-muted-foreground" size={16} />
          <span>Links in X posts</span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          X charges extra for posts with a link, so we remove links from X posts by default. Turn
          this on to keep them in.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {priceLabel} &bull;{' '}
            {xLinks.limit === null
              ? 'Unlimited link posts'
              : xLinks.enabled
                ? `${xLinks.remaining ?? 0} of ${xLinks.limit} link posts left every ${xLinks.windowDays} days`
                : `${xLinks.limit} link posts every ${xLinks.windowDays} days`}
          </span>
          {xLinks.enabled && xLinks.limit !== null ? (
            <SegmentedMeter
              included={xLinks.limit}
              label="X link posts remaining"
              left={xLinks.remaining ?? 0}
            />
          ) : null}
        </div>
        {xLinks.cancelsAt ? (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
            Active until {formatBillingDate(xLinks.cancelsAt)}, then links will be removed from X
            posts again.
          </p>
        ) : null}
        {exhausted && xLinks.nextSlotAt ? (
          <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
            All {xLinks.limit} rolling {xLinks.windowDays}-day slots are used. Next slot opens{' '}
            {formatBillingDate(xLinks.nextSlotAt)}.
          </p>
        ) : null}
        {!canManage ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            Only workspace owners can manage billing add-ons.
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-row items-center gap-2 sm:flex-col sm:items-end">
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {canManage ? (
          xLinks.status === 'canceling' && paid ? (
            <Button
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => setEnableOpen(true)}
              size="sm"
              type="button"
            >
              Keep on
            </Button>
          ) : canTurnOff ? (
            <Button
              onClick={() => setDisableOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Turn off
            </Button>
          ) : paid ? (
            <Button
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => setEnableOpen(true)}
              size="sm"
              type="button"
            >
              Turn on
            </Button>
          ) : null
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel={
          xLinks.status === 'canceling'
            ? 'Keep add-on active'
            : `Continue to checkout (${usd(xLinks.priceMonthlyUsd)}/mo)`
        }
        description={
          xLinks.status === 'canceling' ? (
            <p>
              Keep <strong>Links in X posts</strong> active at {priceLabel} for {limitLabel}.
            </p>
          ) : (
            <>
              <p>
                Add <strong>Links in X posts</strong> for <strong>{priceLabel}</strong>. Your
                workspace gets <strong>{limitLabel}</strong> (tweets, thread replies, auto-plugs,
                and quotes).
              </p>
              <p>
                Billed separately each month so it works alongside monthly or annual base plans.
                Cancel anytime.
              </p>
            </>
          )
        }
        onConfirm={handleEnable}
        onOpenChange={setEnableOpen}
        open={enableOpen}
        title={
          xLinks.status === 'canceling' ? 'Keep Links in X posts on?' : 'Turn on Links in X posts?'
        }
      />

      <ConfirmDialog
        confirmLabel="Turn off at period end"
        description={
          <>
            <p>
              Your workspace will keep links in X posts until the end of the current monthly billing
              period. After that, links will be removed from outbound X posts by default.
            </p>
            <p>
              Links on other platforms (LinkedIn, Bluesky, Threads, Mastodon) are never affected.
            </p>
          </>
        }
        destructive
        onConfirm={handleDisable}
        onOpenChange={setDisableOpen}
        open={disableOpen}
        title="Turn off Links in X posts?"
      />
    </div>
  )
}

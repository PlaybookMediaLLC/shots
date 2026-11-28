'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CloseIcon } from '@/components/platform-shell/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { z } from 'zod'
import {
  previewSubscriptionChangeContract,
  switchSubscriptionPlanContract,
} from '@/lib/api/contracts/billing'
import { checkoutPlanSchema, usd } from '@/lib/billing/plans'
import { getErrorMessage, requestJson } from '../settings-client'
import { type BillingSubscription, formatBillingDate } from './types'

type PreviewResult = z.infer<typeof previewSubscriptionChangeContract.output>

/**
 * Dismissible promo card shown to active monthly self-serve workspaces,
 * deriving exact annual savings from PLAN_PRICES and ANNUAL_DISCOUNT.
 */
export function AnnualBillingBanner({
  onSwitched,
  plan,
  subscription,
}: {
  onSwitched: () => void
  plan: string
  subscription: BillingSubscription | null
}) {
  const offer = subscription?.cycle?.annualOffer
  const parsedPlan = checkoutPlanSchema.safeParse(plan).data
  const [dismissed, setDismissed] = useState(false)
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!offer || !parsedPlan || dismissed) return null

  const openConfirm = async () => {
    setOpen(true)
    setError(null)
    setPreview(null)
    setLoadingPreview(true)
    try {
      const result = await requestJson(
        previewSubscriptionChangeContract.path,
        previewSubscriptionChangeContract.output,
        {
          body: { interval: 'annual', plan: parsedPlan },
          method: 'POST',
        }
      )
      setPreview(result)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setLoadingPreview(false)
    }
  }

  const confirmSwitch = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await requestJson(
        switchSubscriptionPlanContract.path,
        switchSubscriptionPlanContract.output,
        {
          body: { interval: 'annual', plan: parsedPlan },
          method: 'POST',
        }
      )
      toast.success('Switched to annual billing.')
      setOpen(false)
      onSwitched()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="relative flex flex-col gap-4 rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 pr-6">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-emerald-500" />
            <p className="text-sm font-semibold text-foreground">
              Save {usd(offer.savingsUsd)}/year with annual billing
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {usd(offer.annualPriceUsd)}/year instead of {usd(offer.monthlyAnnualizedUsd)}. Same plan,
            nothing else changes.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            className="rounded-full bg-emerald-600 px-4 text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            onClick={() => void openConfirm()}
            size="sm"
            type="button"
          >
            Switch to annual
          </Button>
          <Button
            aria-label="Dismiss annual billing offer"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => setDismissed(true)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <CloseIcon size={14} />
          </Button>
        </div>
      </div>

      <Dialog onOpenChange={(next) => !submitting && setOpen(next)} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch to annual billing</DialogTitle>
            <DialogDescription>
              Move to {usd(offer.annualPriceUsd)}/year and save {usd(offer.savingsUsd)} every year.
              Unused time on your current monthly cycle is automatically prorated.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            {loadingPreview ? (
              <p className="text-muted-foreground">Calculating prorated amount…</p>
            ) : preview ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Estimated prorated charge today</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {preview.amountDueLabel}
                  </span>
                </div>
                {preview.nextBillingDate ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Next annual renewal</span>
                    <span className="text-foreground tabular-nums">
                      {formatBillingDate(preview.nextBillingDate)}
                    </span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={submitting || loadingPreview}
              onClick={() => void confirmSwitch()}
              type="button"
            >
              {submitting ? 'Switching…' : 'Confirm annual switch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

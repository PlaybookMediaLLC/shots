'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { CtaLink } from '@/components/platform-landing/CtaLink'
import { CalendarIcon, CreditCardIcon, ReceiptIcon } from '@/components/platform-shell/icons'
import { Pill } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { z } from 'zod'
import {
  cancelSubscriptionContract,
  createBillingPortalContract,
  pauseSubscriptionContract,
  reactivateSubscriptionContract,
  resumeSubscriptionContract,
  switchSubscriptionPlanContract,
} from '@/lib/api/contracts/billing'
import {
  ANNUAL_DISCOUNT,
  annualMonthlyPrice,
  type billingIntervalSchema,
  checkoutPlanSchema,
  PLAN_PRICES,
  usd,
} from '@/lib/billing/plans'
import { getErrorMessage, requestJson } from '../settings-client'
import {
  BILLING_STATUS,
  type BillingSubscription,
  type BillingSummary,
  formatBillingDate,
  PLAN_TITLES,
} from './types'

type PlanChoice = z.infer<typeof checkoutPlanSchema>
type IntervalChoice = z.infer<typeof billingIntervalSchema>

/**
 * Primary subscription card displaying current plan, status pill, next billing
 * date and amount, plus Change Plan / Pause / Cancel lifecycle controls.
 */
export function CurrentPlanCard({
  canManage,
  onChanged,
  onRetrySubscription,
  subscription,
  subscriptionError,
  subscriptionLoading,
  summary,
}: {
  canManage: boolean
  onChanged: () => void
  onRetrySubscription: () => void
  subscription: BillingSubscription | null
  subscriptionError: string | null
  subscriptionLoading: boolean
  summary: BillingSummary
}) {
  const cycle = subscription?.cycle ?? null
  const isPaused = summary.status === 'paused' || Boolean(cycle?.paused)
  const isSelfServe = Boolean(cycle) && summary.plan !== 'enterprise'

  const [changePlanOpen, setChangePlanOpen] = useState(false)
  const [targetPlan, setTargetPlan] = useState<PlanChoice>(
    checkoutPlanSchema.catch('pro').parse(summary.plan)
  )
  const [targetInterval, setTargetInterval] = useState<IntervalChoice>(cycle?.interval ?? 'monthly')
  const [changeError, setChangeError] = useState<string | null>(null)
  const [changingPlan, setChangingPlan] = useState(false)

  const [pauseOpen, setPauseOpen] = useState(false)
  const [pauseMonths, setPauseMonths] = useState<string>('1')

  const [resumeOpen, setResumeOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [reactivateOpen, setReactivateOpen] = useState(false)
  const [portalBusy, setPortalBusy] = useState(false)

  const statusMeta = isPaused
    ? BILLING_STATUS.paused
    : cycle?.cancelsAt
      ? { label: 'Cancels soon', tone: 'yellow' as const }
      : (BILLING_STATUS[summary.status] ?? { label: summary.status, tone: 'gray' as const })

  const openChangePlan = () => {
    setTargetPlan(checkoutPlanSchema.catch('pro').parse(summary.plan))
    setTargetInterval(cycle?.interval ?? 'monthly')
    setChangeError(null)
    setChangePlanOpen(true)
  }

  const submitPlanChange = async () => {
    setChangingPlan(true)
    setChangeError(null)
    try {
      await requestJson(
        switchSubscriptionPlanContract.path,
        switchSubscriptionPlanContract.output,
        {
          body: { interval: targetInterval, plan: targetPlan },
          method: 'POST',
        }
      )
      toast.success('Subscription plan updated.')
      setChangePlanOpen(false)
      onChanged()
    } catch (requestError) {
      setChangeError(getErrorMessage(requestError))
    } finally {
      setChangingPlan(false)
    }
  }

  const openPaymentMethodPortal = async () => {
    setPortalBusy(true)
    try {
      const { url } = await requestJson(
        createBillingPortalContract.path,
        createBillingPortalContract.output,
        { body: { flow: 'payment_method_update' }, method: 'POST' }
      )
      window.location.assign(url)
    } catch (requestError) {
      toast.error(getErrorMessage(requestError))
      setPortalBusy(false)
    }
  }

  const handlePause = async (): Promise<string | null> => {
    try {
      const parsed = pauseMonths === 'indefinite' ? null : (Number(pauseMonths) as 1 | 2 | 3)
      await requestJson(pauseSubscriptionContract.path, pauseSubscriptionContract.output, {
        body: { resumeInMonths: parsed },
        method: 'POST',
      })
      toast.success('Subscription paused.')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const handleResume = async (): Promise<string | null> => {
    try {
      await requestJson(resumeSubscriptionContract.path, resumeSubscriptionContract.output, {
        body: {},
        method: 'POST',
      })
      toast.success('Subscription resumed.')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const handleCancel = async (): Promise<string | null> => {
    try {
      await requestJson(cancelSubscriptionContract.path, cancelSubscriptionContract.output, {
        body: cancelReason.trim() ? { reason: cancelReason.trim() } : {},
        method: 'POST',
      })
      toast.success('Subscription will cancel at the end of the current period.')
      setCancelReason('')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const handleReactivate = async (): Promise<string | null> => {
    try {
      await requestJson(
        reactivateSubscriptionContract.path,
        reactivateSubscriptionContract.output,
        { body: {}, method: 'POST' }
      )
      toast.success('Scheduled cancellation removed.')
      onChanged()
      return null
    } catch (requestError) {
      return getErrorMessage(requestError)
    }
  }

  const dateLabel = isPaused
    ? cycle?.resumesAt
      ? 'Resumes on'
      : 'Billing status'
    : cycle?.cancelsAt
      ? 'Ends on'
      : 'Next billing date'

  const dateValue = isPaused
    ? cycle?.resumesAt
      ? formatBillingDate(cycle.resumesAt)
      : 'Paused until resumed'
    : cycle?.cancelsAt
      ? formatBillingDate(cycle.cancelsAt)
      : cycle?.renewsAt
        ? formatBillingDate(cycle.renewsAt)
        : null

  return (
    <div className="flex flex-col gap-5 rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <CreditCardIcon className="shrink-0" size={15} />
            <span>Current Plan</span>
          </div>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-foreground">
            {PLAN_TITLES[summary.plan] ?? summary.plan}
          </h2>
          {summary.paid || isPaused ? (
            <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
              {cycle?.priceLabel ??
                (subscriptionLoading
                  ? 'Loading subscription…'
                  : summary.plan === 'enterprise'
                    ? 'Contract pricing — see your agreement'
                    : subscriptionError
                      ? 'Subscription temporarily unavailable'
                      : 'No online subscription linked')}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose a plan to start using Shots: Pro or Business by card, or Enterprise through
              sales.
            </p>
          )}
        </div>
        {summary.paid || isPaused ? <Pill tone={statusMeta.tone}>{statusMeta.label}</Pill> : null}
      </div>

      {summary.status === 'past_due' ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              The last payment failed. Update your payment method to keep your plan
              {summary.graceUntil
                ? ` after ${formatBillingDate(String(summary.graceUntil))}`
                : ''}
              .
            </span>
            {canManage ? (
              <Button
                disabled={portalBusy}
                onClick={() => void openPaymentMethodPortal()}
                size="sm"
                type="button"
              >
                {portalBusy ? 'Opening…' : 'Update payment method'}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {(summary.paid || isPaused) && cycle ? (
        <div className="grid grid-cols-1 gap-4 border-t border-border/70 pt-4 sm:grid-cols-2">
          <div className="flex items-start gap-2.5">
            <CalendarIcon className="mt-0.5 shrink-0 text-muted-foreground" size={16} />
            <div>
              <p className="text-xs text-muted-foreground">{dateLabel}</p>
              <p className="mt-0.5 text-sm font-medium text-foreground tabular-nums">
                {dateValue ?? '—'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <ReceiptIcon className="mt-0.5 shrink-0 text-muted-foreground" size={16} />
            <div>
              <p className="text-xs text-muted-foreground">Amount</p>
              <p className="mt-0.5 text-sm font-medium text-foreground tabular-nums">
                {cycle.amountLabel ?? '—'}
              </p>
              {summary.addons.xLinks.enabled ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Plus {usd(summary.addons.xLinks.priceMonthlyUsd)}/month for Links in X posts
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {(summary.paid || isPaused) && !cycle && subscriptionError ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="text-xs text-muted-foreground">{subscriptionError}</p>
          <Button
            disabled={subscriptionLoading}
            onClick={onRetrySubscription}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry subscription details
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
        {!summary.paid && !isPaused ? (
          canManage ? (
            <CtaLink href="/pricing" label="Choose a plan" location="workspace_billing_choose" />
          ) : (
            <p className="text-xs text-muted-foreground">
              Only workspace owners can choose or change the plan.
            </p>
          )
        ) : !canManage ? (
          <p className="text-xs text-muted-foreground">
            Only workspace owners can change, pause, or cancel the subscription.
          </p>
        ) : isSelfServe ? (
          <>
            {!isPaused ? (
              <Button onClick={openChangePlan} size="sm" type="button">
                Change Plan
              </Button>
            ) : null}
            {isPaused ? (
              <Button onClick={() => setResumeOpen(true)} size="sm" type="button">
                Resume Subscription
              </Button>
            ) : (
              <Button onClick={() => setPauseOpen(true)} size="sm" type="button">
                Pause Subscription
              </Button>
            )}
            {cycle?.cancelsAt ? (
              <Button onClick={() => setReactivateOpen(true)} size="sm" type="button">
                Keep Subscription
              </Button>
            ) : (
              <Button onClick={() => setCancelOpen(true)} size="sm" type="button">
                Cancel Subscription
              </Button>
            )}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {summary.plan === 'enterprise'
              ? 'Enterprise plans are managed through your account agreement.'
              : 'No online subscription is linked to this workspace.'}
          </p>
        )}
      </div>

      {/* Change Plan dialog */}
      <Dialog onOpenChange={(next) => !changingPlan && setChangePlanOpen(next)} open={changePlanOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Plan</DialogTitle>
            <DialogDescription>
              Switch between Pro and Business or change your billing interval. Unused time is
              prorated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="billing-target-plan">Plan</Label>
              <Select
                onValueChange={(value) => setTargetPlan(value as PlanChoice)}
                value={targetPlan}
              >
                <SelectTrigger id="billing-target-plan">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pro">
                    Pro — {usd(PLAN_PRICES.pro)}/mo ({usd(annualMonthlyPrice('pro'))}/mo annual)
                  </SelectItem>
                  <SelectItem value="business">
                    Business — {usd(PLAN_PRICES.business)}/mo (
                    {usd(annualMonthlyPrice('business'))}/mo annual)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="billing-target-interval">Billing interval</Label>
              <Select
                onValueChange={(value) => setTargetInterval(value as IntervalChoice)}
                value={targetInterval}
              >
                <SelectTrigger id="billing-target-interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">
                    Monthly ({usd(PLAN_PRICES[targetPlan])}/month)
                  </SelectItem>
                  <SelectItem value="annual">
                    Annual ({usd(annualMonthlyPrice(targetPlan) * 12)}/year —{' '}
                    {Math.round(ANNUAL_DISCOUNT * 100)}% off)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {changeError ? (
              <p className="text-sm text-destructive" role="alert">
                {changeError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              disabled={changingPlan}
              onClick={() => setChangePlanOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={changingPlan} onClick={() => void submitPlanChange()} type="button">
              {changingPlan ? 'Updating…' : 'Update plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pause Subscription dialog */}
      <ConfirmDialog
        confirmLabel="Pause Subscription"
        description={
          <>
            <p>
              Pausing stops billing collection while keeping all drafts, campaigns, assets, and
              connected channels intact. New scheduling and AI features pause until you resume
              (cancel any already-queued posts you do not want sent).
            </p>
            {summary.addons.xLinks.enabled ? (
              <p>Your Links in X posts add-on will also pause so you are not billed for it.</p>
            ) : null}
          </>
        }
        onConfirm={handlePause}
        onOpenChange={setPauseOpen}
        open={pauseOpen}
        title="Pause your subscription?"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="pause-duration">Pause duration</Label>
          <Select onValueChange={setPauseMonths} value={pauseMonths}>
            <SelectTrigger id="pause-duration">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 month</SelectItem>
              <SelectItem value="2">2 months</SelectItem>
              <SelectItem value="3">3 months</SelectItem>
              <SelectItem value="indefinite">Until I resume manually</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>

      {/* Resume Subscription dialog */}
      <ConfirmDialog
        confirmLabel="Resume Subscription"
        description={
          <p>
            Resume billing immediately and restore publishing, AI credits, and workspace features.
          </p>
        }
        onConfirm={handleResume}
        onOpenChange={setResumeOpen}
        open={resumeOpen}
        title="Resume your subscription?"
      />

      {/* Cancel Subscription dialog */}
      <ConfirmDialog
        confirmLabel="Cancel at period end"
        description={
          <>
            <p>
              Your plan stays active until{' '}
              <strong>{cycle?.renewsAt ? formatBillingDate(cycle.renewsAt) : 'period end'}</strong>.
              Your drafts, campaigns, and assets remain stored, and you can resubscribe anytime.
            </p>
            {summary.addons.xLinks.enabled ? (
              <p>
                Your Links in X posts add-on will also be scheduled to stop so you are not billed
                after your plan ends.
              </p>
            ) : null}
          </>
        }
        destructive
        onConfirm={handleCancel}
        onOpenChange={setCancelOpen}
        open={cancelOpen}
        title="Cancel your subscription?"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="cancel-reason">Reason for cancelling (optional)</Label>
          <Textarea
            id="cancel-reason"
            maxLength={500}
            onChange={(event) => setCancelReason(event.target.value)}
            placeholder="Let us know what we could improve…"
            rows={3}
            value={cancelReason}
          />
        </div>
      </ConfirmDialog>

      {/* Keep Subscription dialog */}
      <ConfirmDialog
        confirmLabel="Keep Subscription"
        description={
          <p>
            Remove the scheduled cancellation so your subscription continues renewing automatically.
          </p>
        }
        onConfirm={handleReactivate}
        onOpenChange={setReactivateOpen}
        open={reactivateOpen}
        title="Keep your subscription?"
      />
    </div>
  )
}

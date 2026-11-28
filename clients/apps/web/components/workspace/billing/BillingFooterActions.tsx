'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { CreditCardIcon, OutwardIcon, ReceiptIcon } from '@/components/platform-shell/icons'
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
import {
  createBillingPortalContract,
  requestRefundContract,
} from '@/lib/api/contracts/billing'
import { useTRPC } from '@/lib/trpc/react'
import { getErrorMessage, requestJson } from '../settings-client'
import { formatBillingDate } from './types'

/**
 * Footer actions matching the target billing layout: Stripe Billing Portal
 * launch button, Request Refund modal trigger, and helper caption.
 */
export function BillingFooterActions({
  canManage,
  hasStripeSubscription,
}: {
  canManage: boolean
  hasStripeSubscription: boolean
}) {
  const trpc = useTRPC()
  const [portalBusy, setPortalBusy] = useState(false)
  const [refundOpen, setRefundOpen] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState<string>('none')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invoicesQuery = useQuery(
    trpc.billing.recentInvoices.queryOptions(undefined, {
      enabled: canManage && refundOpen && hasStripeSubscription,
      retry: false,
      staleTime: 60_000,
    })
  )
  const invoices = invoicesQuery.data?.invoices ?? []
  const loadingInvoices = invoicesQuery.isLoading

  if (!canManage) return null

  const openPortal = async () => {
    setPortalBusy(true)
    try {
      const { url } = await requestJson(
        createBillingPortalContract.path,
        createBillingPortalContract.output,
        { body: {}, method: 'POST' }
      )
      window.location.assign(url)
    } catch (requestError) {
      toast.error(getErrorMessage(requestError))
      setPortalBusy(false)
    }
  }

  const openRefundModal = () => {
    setRefundOpen(true)
    setError(null)
  }

  const submitRefund = async () => {
    if (reason.trim().length < 10) {
      setError('Please include a brief explanation (at least 10 characters).')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await requestJson(
        requestRefundContract.path,
        requestRefundContract.output,
        {
          body: {
            ...(selectedInvoice !== 'none' ? { invoiceId: selectedInvoice } : {}),
            reason: reason.trim(),
          },
          method: 'POST',
        }
      )
      toast.success(`Refund request submitted (${result.referenceId}).`)
      setRefundOpen(false)
      setReason('')
      setSelectedInvoice('none')
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <div className="flex flex-wrap items-center gap-2.5">
        {hasStripeSubscription ? (
          <Button
            disabled={portalBusy}
            onClick={() => void openPortal()}
            size="sm"
            type="button"
            variant="outline"
          >
            <CreditCardIcon size={15} />
            <span>{portalBusy ? 'Opening Stripe…' : 'Stripe Billing Portal'}</span>
            <OutwardIcon className="text-muted-foreground" size={13} />
          </Button>
        ) : null}
        <Button onClick={openRefundModal} size="sm" type="button" variant="outline">
          <ReceiptIcon size={15} />
          <span>Request Refund</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Access billing history, payment methods, and invoices
      </p>

      <Dialog onOpenChange={(next) => !submitting && setRefundOpen(next)} open={refundOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request a refund</DialogTitle>
            <DialogDescription>
              Send a refund request to our billing team. We review every request and reply by email
              within two business days.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            {hasStripeSubscription ? (
              <div className="grid gap-1.5">
                <Label htmlFor="refund-invoice">Charge or invoice (optional)</Label>
                <Select
                  disabled={loadingInvoices}
                  onValueChange={setSelectedInvoice}
                  value={selectedInvoice}
                >
                  <SelectTrigger id="refund-invoice">
                    <SelectValue
                      placeholder={
                        loadingInvoices ? 'Loading recent invoices…' : 'Select an invoice'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">General billing / not sure</SelectItem>
                    {invoices.map((invoice) => (
                      <SelectItem key={invoice.id} value={invoice.id}>
                        {invoice.number ?? invoice.id} — {invoice.amountPaidLabel} (
                        {formatBillingDate(invoice.createdAt)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="refund-reason">Details</Label>
              <Textarea
                id="refund-reason"
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Tell us which charge you're asking about and why…"
                rows={4}
                value={reason}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              disabled={submitting}
              onClick={() => setRefundOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={submitting} onClick={() => void submitRefund()} type="button">
              {submitting ? 'Submitting…' : 'Submit request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

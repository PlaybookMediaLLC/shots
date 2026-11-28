import 'server-only'

import { randomUUID } from 'node:crypto'
import { BillingError, verifyWorkspaceInvoice } from '@/lib/billing/stripe'
import { sendBatch } from '@/lib/email/transport'

const SUPPORT_EMAIL = 'team@playbookmedia.io'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Validates any supplied Stripe invoice against the workspace, emails support
 * with the refund request, and returns a reference ID for the audit trail.
 */
export async function submitBillingRefundRequest(
  input: {
    invoiceId?: string
    organizationId: string
    reason: string
    requesterEmail: string
    requesterName: string
  },
  deps: {
    hasEmailKey?: () => boolean
    send?: typeof sendBatch
    verifyInvoice?: typeof verifyWorkspaceInvoice
  } = {}
): Promise<{ invoiceNumber: string | null; referenceId: string }> {
  const verifyInvoice = deps.verifyInvoice ?? verifyWorkspaceInvoice
  const send = deps.send ?? sendBatch
  const hasEmailKey = deps.hasEmailKey ?? (() => Boolean(process.env.RESEND_API_KEY))

  const verifiedInvoice = input.invoiceId
    ? await verifyInvoice(input.organizationId, input.invoiceId)
    : null
  if (input.invoiceId && !verifiedInvoice) {
    throw new BillingError('The selected invoice does not belong to this workspace.', 400)
  }

  const referenceId = `ref_${randomUUID().slice(0, 12)}`
  const invoiceLine = verifiedInvoice
    ? `Invoice: ${verifiedInvoice.number ?? verifiedInvoice.id} (${verifiedInvoice.amountPaidLabel}, paid ${verifiedInvoice.createdAt})`
    : 'Invoice: Not specified'

  const supportText = [
    `Refund request ${referenceId}`,
    `Workspace ID: ${input.organizationId}`,
    `Requested by: ${input.requesterName} <${input.requesterEmail}>`,
    invoiceLine,
    '',
    'Reason:',
    input.reason,
  ].join('\n')

  const supportHtml = [
    `<h2>Refund request ${escapeHtml(referenceId)}</h2>`,
    `<p><strong>Workspace ID:</strong> ${escapeHtml(input.organizationId)}<br/>`,
    `<strong>Requested by:</strong> ${escapeHtml(input.requesterName)} &lt;${escapeHtml(input.requesterEmail)}&gt;<br/>`,
    `<strong>${escapeHtml(invoiceLine)}</strong></p>`,
    `<p><strong>Reason:</strong></p>`,
    `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(input.reason)}</pre>`,
  ].join('')

  const receiptText = [
    `We received your refund request (${referenceId}).`,
    invoiceLine,
    '',
    'Our team will review it and reply within two business days.',
  ].join('\n')

  const receiptHtml = [
    `<p>We received your refund request (<strong>${escapeHtml(referenceId)}</strong>).</p>`,
    `<p>${escapeHtml(invoiceLine)}</p>`,
    `<p>Our team will review it and reply within two business days.</p>`,
  ].join('')

  if (!hasEmailKey()) {
    throw new BillingError(
      'Refund email delivery is not configured yet. Please email team@playbookmedia.io directly.',
      503
    )
  }

  const delivery = await send([
    {
      html: supportHtml,
      replyTo: input.requesterEmail,
      subject: `[Shots Billing] Refund request ${referenceId} (${input.organizationId})`,
      text: supportText,
      to: SUPPORT_EMAIL,
    },
    {
      html: receiptHtml,
      subject: `We received your Shots refund request (${referenceId})`,
      text: receiptText,
      to: input.requesterEmail,
    },
  ])

  const supportFailure = delivery.failed.find((item) => item.email === SUPPORT_EMAIL)
  if (supportFailure) {
    throw new BillingError(
      'Could not send the refund request right now. Please email team@playbookmedia.io directly.',
      503
    )
  }

  return {
    invoiceNumber: verifiedInvoice?.number ?? verifiedInvoice?.id ?? null,
    referenceId,
  }
}

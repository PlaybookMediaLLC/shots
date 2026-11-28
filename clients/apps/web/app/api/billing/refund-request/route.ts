import { requestRefundContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { submitBillingRefundRequest } from '@/lib/billing/refund'

/** Workspace owners submit an audited refund request routed to billing support. */
export const POST = route(requestRefundContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) => {
    const sdk = backendSDK(access)
    const { user } = await sdk.getCurrentUser()
    const { invoiceNumber, referenceId } = await submitBillingRefundRequest({
      invoiceId: body.invoiceId,
      organizationId: access.organizationId,
      reason: body.reason,
      requesterEmail: user.email,
      requesterName: user.name || user.email,
    })
    await sdk.appendAuditEvent({
      action: 'billing.refund_requested',
      entityId: access.organizationId,
      entityType: 'workspace_entitlement',
      metadata: {
        invoiceId: body.invoiceId ?? null,
        invoiceNumber,
        referenceId,
      },
      outcome: 'SUCCEEDED',
    })
    return { referenceId, submitted: true }
  },
})

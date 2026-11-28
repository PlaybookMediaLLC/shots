import assert from 'node:assert/strict'
import test from 'node:test'
import { submitBillingRefundRequest } from '@/lib/billing/refund'
import { BillingError } from '@/lib/billing/stripe'

test('submitBillingRefundRequest rejects cross-tenant or unknown invoices with 400 before sending email', async () => {
  let sendCalled = false
  await assert.rejects(
    () =>
      submitBillingRefundRequest(
        {
          invoiceId: 'in_other_tenant',
          organizationId: 'org_1',
          reason: 'Accidental duplicate renewal on this workspace.',
          requesterEmail: 'owner@example.com',
          requesterName: 'Workspace Owner',
        },
        {
          hasEmailKey: () => true,
          send: async () => {
            sendCalled = true
            return { delivered: new Map(), failed: [] }
          },
          verifyInvoice: async () => null,
        }
      ),
    (error: unknown) => error instanceof BillingError && error.status === 400
  )
  assert.equal(sendCalled, false)
})

test('submitBillingRefundRequest escapes HTML and emails support + requester for owned paid invoice', async () => {
  const batches: Array<{ html: string; subject: string; text: string; to: string }> = []
  const result = await submitBillingRefundRequest(
    {
      invoiceId: 'in_owned_1',
      organizationId: 'org_1',
      reason: 'Please refund <script>alert(1)</script> & charge.',
      requesterEmail: 'owner@example.com',
      requesterName: 'Jane <Owner>',
    },
    {
      hasEmailKey: () => true,
      send: async (messages) => {
        for (const msg of messages) {
          batches.push({ html: msg.html, subject: msg.subject, text: msg.text, to: msg.to })
        }
        return {
          delivered: new Map(messages.map((m) => [m.to, 'msg_1'])),
          failed: [],
        }
      },
      verifyInvoice: async (orgId, invId) => {
        assert.equal(orgId, 'org_1')
        assert.equal(invId, 'in_owned_1')
        return {
          amountPaidLabel: '$29.00',
          createdAt: '2026-11-28T00:00:00.000Z',
          id: 'in_owned_1',
          number: 'INV-0001',
        }
      },
    }
  )

  assert.equal(result.invoiceNumber, 'INV-0001')
  assert.match(result.referenceId, /^ref_/)
  assert.equal(batches.length, 2)
  assert.equal(batches[0]?.to, 'team@playbookmedia.io')
  assert.match(batches[0]?.html ?? '', /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; charge\./)
  assert.doesNotMatch(batches[0]?.html ?? '', /<script>/)
  assert.equal(batches[1]?.to, 'owner@example.com')
})

test('submitBillingRefundRequest fails closed with 503 when email is unconfigured or support delivery fails', async () => {
  await assert.rejects(
    () =>
      submitBillingRefundRequest(
        {
          organizationId: 'org_1',
          reason: 'Requested a refund after upgrading accidentally.',
          requesterEmail: 'owner@example.com',
          requesterName: 'Jane',
        },
        { hasEmailKey: () => false }
      ),
    (error: unknown) => error instanceof BillingError && error.status === 503
  )

  await assert.rejects(
    () =>
      submitBillingRefundRequest(
        {
          organizationId: 'org_1',
          reason: 'Requested a refund after upgrading accidentally.',
          requesterEmail: 'owner@example.com',
          requesterName: 'Jane',
        },
        {
          hasEmailKey: () => true,
          send: async () => ({
            delivered: new Map(),
            failed: [{ email: 'team@playbookmedia.io', reason: 'smtp down' }],
          }),
        }
      ),
    (error: unknown) => error instanceof BillingError && error.status === 503
  )
})

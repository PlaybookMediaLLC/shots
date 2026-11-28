'use client'

import { CheckoutButton } from '@/components/platform-landing/CheckoutButton'
import { checkoutPathSchema } from '@/components/platform-landing/primitives'
import { Group, Row, Section } from '@/components/platform-ui'
import { UsageMeterRow } from '@/components/settings/SegmentedMeter'
import { CREDIT_PACKS } from '@/lib/billing/plans'
import type { BillingSummary } from './types'

/**
 * Preserves Shots' monthly UTC allowance meters (AI credits, scheduled posts,
 * release emails) and one-time launch credit pack purchases below the main
 * subscription and add-on cards.
 */
export function UsageAndCreditsCard({
  canManage,
  summary,
}: {
  canManage: boolean
  summary: BillingSummary
}) {
  if (!summary.paid) return null

  return (
    <Section
      description={`Allowances reset ${new Date(summary.usagePeriod.resetsAt).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })} at 00:00 UTC, independently of your subscription renewal.`}
      title="Monthly allowances & credits"
    >
      <Group>
        <UsageMeterRow
          allowance={summary.credits}
          description="AI credits left this month. One credit is one cent of AI cost."
          label="AI credits"
        />
        <Row
          description="Extra launch credits are spent after the monthly allowance and do not expire."
          label="Extra launch credits"
          layout="inline"
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-ui-lg font-medium text-foreground tabular-nums">
              {summary.creditBalance.toLocaleString('en-US')}
            </span>
            {canManage ? (
              <CheckoutButton
                choices={[
                  {
                    body: { pack: 'launch' },
                    label: `Buy ${CREDIT_PACKS.launch.credits} credits (${CREDIT_PACKS.launch.price})`,
                  },
                ]}
                className="w-auto"
                location="workspace_billing_extra_launch"
                path={checkoutPathSchema.enum['/api/billing/credits']}
                surface="app"
              />
            ) : null}
          </div>
        </Row>
        <UsageMeterRow
          allowance={summary.posts}
          description="Scheduled posts left this month."
          label="Scheduled posts"
        />
        <UsageMeterRow
          allowance={summary.emails}
          description="Release emails left this month, counted per recipient."
          label="Emails"
        />
      </Group>
    </Section>
  )
}

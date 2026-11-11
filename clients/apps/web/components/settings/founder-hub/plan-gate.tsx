// Ported from apps/desktop/src/settings/plan-gate.tsx; see dev/import-founder-hub-ui.mjs.
import { useLingui as _useLingui } from '@lingui/react'
import { type ReactNode, type SyntheticEvent, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useBillingAccess } from '@/components/settings/founder-hub/billing-access'
export type GatedPlan = 'pro' | 'enterprise'
export function useNotifyPlanRequired() {
  const { _: _t } = _useLingui()
  const { upgradeToPro } = useBillingAccess()
  return useCallback(
    (plan: GatedPlan) => {
      const message =
        plan === 'pro'
          ? _t(
              /*i18n*/
              {
                id: '12d5nP',
                message: 'This requires Shots Founder Hub Pro',
              }
            )
          : _t(
              /*i18n*/
              {
                id: 'BRnuTo',
                message: 'This requires Shots Founder Hub Enterprise',
              }
            )
      toast.warning(message, {
        ...(plan === 'pro'
          ? {
              action: {
                label: _t(
                  /*i18n*/
                  {
                    id: 'kwkhPe',
                    message: 'Upgrade',
                  }
                ),
                onClick: () => {
                  upgradeToPro()
                },
              },
            }
          : {}),
      })
    },
    [_t, upgradeToPro]
  )
}
export function PlanGate({
  plan,
  allowed,
  children,
  className,
}: {
  plan: GatedPlan
  allowed: boolean
  children: ReactNode
  className?: string
}) {
  const notify = useNotifyPlanRequired()
  const lastNotifyAtRef = useRef(0)
  const block = (event: SyntheticEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const now = Date.now()
    if (now - lastNotifyAtRef.current < 400) {
      return
    }
    lastNotifyAtRef.current = now
    notify(plan)
  }
  if (allowed) {
    return children
  }
  return (
    <div
      className={cn(['relative cursor-not-allowed opacity-60', className])}
      onPointerDownCapture={block}
      onClickCapture={block}
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') {
          return
        }
        block(event)
      }}
    >
      {children}
    </div>
  )
}

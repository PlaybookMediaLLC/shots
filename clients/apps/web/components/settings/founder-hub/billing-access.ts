'use client'

import { useRouter } from '@/i18n/navigation'
import { useFounderHubAccount } from './settings-context'

/** Founder Hub uses the same paid workspace entitlement as its native Shots session. */
export function useBillingAccess() {
  const account = useFounderHubAccount()
  const router = useRouter()
  return {
    isPro: account.workspaces.some((workspace) => workspace.features['workspace:paid']),
    isUpgradingToPro: false,
    upgradeToPro: () => router.push('/settings/billing'),
  }
}

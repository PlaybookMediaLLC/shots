'use client'

import { useQuery } from '@tanstack/react-query'
import {
  connectionAvailabilitySchema,
  type ConnectionAvailability,
} from 'screenshot-studio-backend-sdk'
import { useSocialSetScope } from '@/components/settings/social-sets/scope'

/** Fetch once per opened dialog, with no cached readiness across workspaces. */
export function useConnectionAvailability() {
  const scope = useSocialSetScope()
  return useQuery({
    enabled: scope.ready,
    // A completed connection invalidates social-set lists. Keeping readiness
    // separate prevents that refresh from unmounting an active form/receipt.
    queryKey: ['social-connection-availability', scope.userId, scope.workspaceId],
    queryFn: ({ signal }) =>
      scope.request('/api/v1/social-connection-availability', connectionAvailabilitySchema, {
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

/** Mastodon's picker entry can use the default server or verified custom-server flow. */
export function providerReady(
  data: ConnectionAvailability | undefined,
  provider: string,
  picker = false
): boolean {
  return !!data?.providers.some(
    (item) =>
      item.status === 'available' &&
      (item.provider === provider ||
        (picker && provider === 'mastodon' && item.provider === 'mastodon-custom'))
  )
}

/** The catalog was read and says this provider cannot connect; an unread one says nothing. */
export function providerComingSoon(
  data: ConnectionAvailability | undefined,
  provider: string
): boolean {
  return !!data && !providerReady(data, provider, true)
}

/** Safe user-facing explanations; configuration names never reach the product flow. */
export function providerUnavailableMessage(
  data: ConnectionAvailability | undefined,
  provider: string
): string {
  if (provider === 'substack') return 'Substack Notes has no supported public publishing API.'
  const status = data?.providers.find((item) => item.provider === provider)?.status
  if (status === 'not_configured') return 'Connection setup is not complete yet.'
  return 'This connection is not available yet.'
}

'use client'

import { apiKeyClient } from '@better-auth/api-key/client'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { scimClient } from '@better-auth/scim/client'
import { ssoClient } from '@better-auth/sso/client'
import { getGlobalBroadcastChannel } from 'better-auth/client'
import { createAuthClient } from 'better-auth/react'
import { useSyncExternalStore } from 'react'
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins'
import { betterAuthOrganizationRoles } from './permissions'

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL,
  plugins: [
    oauthProviderClient(),
    organizationClient({ roles: betterAuthOrganizationRoles }),
    apiKeyClient(),
    twoFactorClient({
      onTwoFactorRedirect: () => {
        window.location.assign(`/two-factor${window.location.search}`)
      },
    }),
    ssoClient(),
    scimClient(),
  ],
})

/**
 * Tell this browser's other tabs that the session changed, such as its active
 * workspace, so they read it again. Better Auth's own tab sync carries it.
 */
export function announceSessionChange(): void {
  getGlobalBroadcastChannel().post({
    event: 'session',
    data: { trigger: 'getSession' },
    clientId: crypto.randomUUID(),
  })
}

const subscribeToNothing = () => () => {}

/**
 * The session for client components that also render on the server. Better
 * Auth's store can fill before React hydrates, while the server always renders
 * it as pending; reporting pending until hydration keeps the first client
 * render identical to the server's.
 */
export function useHydratedSession(): ReturnType<typeof authClient.useSession> {
  const session = authClient.useSession()
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  )
  return hydrated ? session : { ...session, data: null, isPending: true }
}

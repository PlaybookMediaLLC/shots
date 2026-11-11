'use client'

import { useMutation, useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth/client'
import { authRedirect } from '@/lib/auth/oauth-navigation'
import { FormAlert } from './fields'

export function FounderHubConsent() {
  const search = useSearchParams()
  const oauthQuery = search.toString()
  const client = useQuery({
    queryKey: ['oauth-consent-client', oauthQuery],
    queryFn: async () => {
      const result = await authClient.oauth2.publicClientPrelogin({
        client_id: search.get('client_id') ?? '',
        oauth_query: oauthQuery,
      })
      if (result.error) throw new Error(result.error.message ?? 'Authorization request is invalid.')
      return result.data
    },
    retry: false,
  })
  const consent = useMutation({
    mutationFn: async (accept: boolean) => {
      const result = await authClient.oauth2.consent({ accept, oauth_query: oauthQuery })
      if (result.error) throw new Error(result.error.message ?? 'Authorization failed.')
      window.location.assign(authRedirect(result.data, '/sign-in'))
    },
  })
  return (
    <div className="space-y-4">
      {client.data ? (
        <p>
          Allow {client.data.client_name ?? 'this application'} to{' '}
          {search.get('scope')?.split(' ').includes('founder-hub')
            ? 'access your account, sync your notes, and use services allowed by your Shots workspace permissions'
            : 'read the meeting snapshots you enable in Shots Founder Hub and your account profile'}
          ? Access continues until you disconnect it or sign out of this Shots session.
        </p>
      ) : null}
      {client.error ? <FormAlert>{client.error.message}</FormAlert> : null}
      {consent.error ? <FormAlert>{consent.error.message}</FormAlert> : null}
      <div className="flex gap-3">
        <Button disabled={consent.isPending || !client.data} onClick={() => consent.mutate(true)}>
          Continue
        </Button>
        <Button
          variant="outline"
          disabled={consent.isPending}
          onClick={() => consent.mutate(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

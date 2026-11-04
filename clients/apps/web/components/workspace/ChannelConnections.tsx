'use client'

import type { ChannelConnection } from 'screenshot-studio-backend-sdk'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ctaClassName } from '@/components/platform-landing/CtaLink'
import { ctaToneSchema } from '@/components/platform-landing/primitives'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'

/** The accounts a workspace can connect, by OAuth provider. */
const PROVIDERS = [
  { label: 'X', provider: 'x' },
  { label: 'LinkedIn', provider: 'linkedin' },
  { label: 'Instagram', provider: 'instagram-standalone' },
  { label: 'Threads', provider: 'threads' },
  { label: 'Mastodon', provider: 'mastodon' },
] as const

/** What a return trip from a provider tells the admin, keyed by the `connected` search parameter. */
const CONNECTED: Record<string, string> = {
  instagram: 'Instagram is connected. Approved Instagram posts can be scheduled to it.',
  'instagram-standalone':
    'Instagram is connected. Approved Instagram posts can be scheduled to it.',
  linkedin: 'LinkedIn is connected. Approved LinkedIn posts can be scheduled to it.',
  mastodon: 'Mastodon is connected. Drafts can be scheduled to it.',
  threads: 'Threads is connected. Drafts can be scheduled to it.',
  x: 'X is connected. Approved X posts can be scheduled to it.',
}

/** Connect the social accounts that approved campaign posts publish to. */
export function ChannelConnections({ canManage }: { canManage: boolean }) {
  const trpcClient = useTRPCClient()
  const connected = useSearchParams().get('connected')
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!canManage) return
    trpcClient.channelConnection.list
      .query()
      .then((result) => setConnections(result.connections))
      .catch((requestError: unknown) => setError(getErrorMessage(requestError)))
  }, [canManage, trpcClient])

  return (
    <Section
      description="Each approved post publishes to an account on its own channel."
      title="Connected accounts"
    >
      {connected && CONNECTED[connected] ? (
        <Alert className="mb-4">
          <AlertDescription>{CONNECTED[connected]}</AlertDescription>
        </Alert>
      ) : null}
      <Group>
        {!canManage ? (
          <Row>
            <p className="text-sm text-muted-foreground">
              Only admins and publishers can connect channels.
            </p>
          </Row>
        ) : (
          <>
            {connections === null ? (
              error ? null : (
                <Row>
                  <p className="text-sm text-muted-foreground">Loading channels…</p>
                </Row>
              )
            ) : connections.length === 0 ? (
              <Row>
                <p className="text-sm text-muted-foreground">No channels connected yet.</p>
              </Row>
            ) : (
              connections.map((connection) => (
                <Row key={connection.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui-lg font-medium text-foreground">
                      {connection.displayName || connection.externalAccountId}
                    </span>
                    {connection.handle ? (
                      <span className="text-sm text-muted-foreground">@{connection.handle}</span>
                    ) : null}
                    <Pill>{connection.platform}</Pill>
                    <Pill tone={connection.status === 'ACTIVE' ? 'green' : 'yellow'}>
                      {connection.status.toLowerCase()}
                    </Pill>
                  </div>
                </Row>
              ))
            )}
            <Row
              description="You sign in with the provider, then return here."
              label="Connect an account"
              layout="inline"
            >
              <div className="flex flex-wrap gap-2">
                {PROVIDERS.map(({ label, provider }) => (
                  // A plain link, not next/link: prefetching the start route would begin an OAuth flow.
                  <a
                    className={ctaClassName(ctaToneSchema.enum.secondary)}
                    href={`/integrations/social/${provider}/start`}
                    key={provider}
                  >
                    Connect {label}
                  </a>
                ))}
              </div>
            </Row>
          </>
        )}
      </Group>
      {error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </Section>
  )
}

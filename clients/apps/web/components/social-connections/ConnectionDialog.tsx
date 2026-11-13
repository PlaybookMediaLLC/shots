'use client'

import { ArrowUpRightIcon as ArrowUpRight } from '@phosphor-icons/react/dist/ssr/ArrowUpRight'
import { CaretRightIcon as ChevronRight } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { LockKeyIcon as LockKeyhole } from '@phosphor-icons/react/dist/ssr/LockKey'
import { NewspaperIcon as Newspaper } from '@phosphor-icons/react/dist/ssr/Newspaper'
import { UsersIcon as Users } from '@phosphor-icons/react/dist/ssr/Users'
import { XIcon as X } from '@phosphor-icons/react/dist/ssr/X'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  socialOAuthBeginRequestSchema,
  socialOAuthBeginResponseSchema,
  socialOAuthProviderSchema,
  type ConnectionAvailability,
} from 'screenshot-studio-backend-sdk'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { useSocialSetScope } from '@/components/settings/social-sets/scope'
import { Button } from '@/components/ui/button'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { settingsErrorMessage } from '@/lib/settings/client'
import type { ConnectionLauncherProps } from './ConnectionLauncher'
import { MastodonServer } from './MastodonServer'
import { BlueskyForm } from './BlueskyForm'
import {
  useConnectionAvailability,
  providerReady,
  providerUnavailableMessage,
} from './availability'

const providers = [
  { id: 'x', label: 'X / Twitter' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'linkedin-page', label: 'LinkedIn Page' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'threads', label: 'Threads' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'substack', label: 'Substack Notes' },
  { id: 'instagram-standalone', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook Page' },
  { id: 'pinterest', label: 'Pinterest' },
] as const

/** A local provider step owns its request lifetime, so leaving it cannot navigate later. */
function ProviderForm({
  provider,
  intent,
  target,
  availability,
}: Omit<ConnectionLauncherProps, 'children'> & {
  provider: string
  availability: ConnectionAvailability
}) {
  const scope = useSocialSetScope()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mastodon = provider === 'mastodon' || provider === 'mastodon-custom'
  const legacyReconnect = provider === 'mastodon' && intent.operation === 'RECONNECT'
  const [mastodonServer, setMastodonServer] = useState(() => {
    if (provider === 'mastodon-custom' && intent.operation === 'RECONNECT') {
      // This is an editable server hint only. The backend verifies the original account ID.
      const handle = target?.accounts.find(
        (account) => account.id === intent.expectedConnectionId
      )?.handle
      return handle?.split('@').at(-1) ?? ''
    }
    return 'mastodon.social'
  })
  const [verifiedServer, setVerifiedServer] = useState<{ server: string; enabled: boolean } | null>(
    null
  )
  const onServerVerified = useCallback((server: string, authorizationEnabled: boolean | null) => {
    setVerifiedServer(
      authorizationEnabled === null ? null : { server, enabled: authorizationEnabled }
    )
  }, [])
  const lifetime = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      lifetime.current = null
    }
  }, [])
  const label =
    provider === 'x'
      ? 'X'
      : mastodon
        ? 'Mastodon'
        : (providers.find((item) => item.id === provider)?.label ?? provider)
  const customAvailable =
    verifiedServer?.server === mastodonServer.trim() &&
    verifiedServer.enabled &&
    providerReady(availability, 'mastodon-custom')
  const oauthProvider =
    mastodon && !legacyReconnect && customAvailable ? 'mastodon-custom' : provider
  const supported = socialOAuthProviderSchema.safeParse(oauthProvider)
  const serverAvailable =
    !mastodon ||
    (customAvailable && !legacyReconnect) ||
    (provider === 'mastodon' &&
      mastodonServer === 'mastodon.social' &&
      (legacyReconnect || verifiedServer?.server === mastodonServer))
  const ready = providerReady(availability, oauthProvider)
  const connect = async () => {
    const controller = lifetime.current
    if (!supported.success || !serverAvailable || !ready || !controller || busy) return
    setBusy(true)
    setError('')
    try {
      const body = socialOAuthBeginRequestSchema.parse({
        ...intent,
        provider: supported.data,
        ...(supported.data === 'mastodon-custom' ? { instanceServer: mastodonServer } : {}),
      })
      const result = await scope.request(
        '/api/v1/social-connection-attempts',
        socialOAuthBeginResponseSchema,
        {
          method: 'POST',
          body,
          signal: controller.signal,
        }
      )
      if (!controller.signal.aborted) window.location.assign(result.url)
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(settingsErrorMessage(cause))
        setBusy(false)
      }
    }
  }
  return (
    <div className="grid gap-5">
      {provider === 'substack' ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Substack Notes are short posts on a Substack profile. Substack does not offer a public
          publishing API, so connecting Notes is currently unavailable. This connection would not
          publish newsletters or articles.{' '}
          <a
            className="underline underline-offset-4"
            href="https://support.substack.com/hc/en-us/articles/360038433912-Does-Substack-have-an-API"
            target="_blank"
            rel="noreferrer"
          >
            Substack API information
          </a>
        </p>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            You’ll go to {label} to choose an account and authorize Shots, then return here to
            finish the connection.
          </p>
          {provider === 'x' ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed">
              Signed in to more than one X account? Check the account you want to connect before
              authorizing.{' '}
              <a
                className="underline underline-offset-4"
                href="https://x.com/account/switch"
                target="_blank"
                rel="noreferrer"
              >
                Switch X account
              </a>
            </p>
          ) : null}
          {mastodon ? (
            <>
              <MastodonServer
                value={mastodonServer}
                onChange={setMastodonServer}
                onVerified={onServerVerified}
                disabled={legacyReconnect}
              />
              {legacyReconnect ? (
                <p className="text-sm text-muted-foreground">
                  Reconnect on the original server, mastodon.social.
                </p>
              ) : null}
              {!serverAvailable && mastodonServer.trim() ? (
                <p className="text-sm text-muted-foreground">
                  Authorization on this server is not enabled yet.
                </p>
              ) : null}
            </>
          ) : null}
          {intent.operation === 'RECONNECT' ? (
            <p className="text-sm text-muted-foreground">
              Choose the same account already connected to {target?.name ?? 'this profile'}.
              Reconnecting preserves its drafts and schedule; it cannot replace the account with
              another identity.
            </p>
          ) : null}
        </>
      )}
      {!ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          {providerUnavailableMessage(availability, oauthProvider)}
        </p>
      ) : null}
      {error ? (
        <p
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}{' '}
          {/* Connecting an account is sensitive: offer the step that clears the refusal. */}
          {/fresh sign-in/i.test(error) ? (
            <a
              className="underline underline-offset-4"
              href={`/sign-in?reauthenticate=1&callbackURL=${encodeURIComponent(window.location.pathname + window.location.search)}`}
            >
              Sign in again
            </a>
          ) : /two-factor/i.test(error) ? (
            <a className="underline underline-offset-4" href="/settings/security">
              Turn on two-factor
            </a>
          ) : null}
        </p>
      ) : null}
      <Button
        className="w-full"
        disabled={!supported.success || !serverAvailable || !ready || busy || !scope.ready}
        onClick={() => void connect()}
        type="button"
      >
        {busy
          ? 'Opening authorization…'
          : supported.success
            ? `Connect ${label} account`
            : 'Connection unavailable'}
        {supported.success && !busy ? <ArrowUpRight className="size-4" aria-hidden /> : null}
      </Button>
    </div>
  )
}

/** Provider selection never creates a set; the backend commits it with its first verified account. */
export default function ConnectionDialog({
  intent,
  target,
  initialProvider,
  onClose,
}: ConnectionLauncherProps & { onClose: () => void }) {
  const availability = useConnectionAvailability()
  const checking = availability.isPending || availability.isFetching
  const catalog = !checking && !availability.isError ? availability.data : undefined
  const [provider, setProvider] = useState<string | null>(initialProvider ?? null)
  const lastProvider = useRef<string | null>(initialProvider ?? null)
  const heading = useRef<HTMLHeadingElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const creating = intent.operation === 'CREATE_SET'
  const label =
    provider === 'x'
      ? 'X'
      : provider === 'mastodon-custom'
        ? 'Mastodon'
        : (providers.find((item) => item.id === provider)?.label ?? provider)
  const close = () => {
    if (provider) {
      lastProvider.current = provider
      setProvider(null)
    } else onClose()
  }
  useLayoutEffect(() => {
    if (provider) heading.current?.focus()
    else if (lastProvider.current)
      picker.current
        ?.querySelector<HTMLButtonElement>(`[data-provider="${lastProvider.current}"]`)
        ?.focus()
  }, [provider])
  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
      showCloseButton={false}
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        close()
      }}
      onPointerDownOutside={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <Button
        variant="custom"
        size={null}
        aria-label={provider ? 'Back to platforms' : 'Close'}
        className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        onClick={close}
        type="button"
      >
        <X aria-hidden className="size-4" />
      </Button>
      <DialogHeader className="pr-7">
        <DialogTitle ref={heading} tabIndex={-1} className="leading-snug outline-none">
          {provider
            ? `${intent.operation === 'RECONNECT' ? 'Reconnect' : 'Connect'} ${label} account`
            : creating
              ? 'Create a profile'
              : `Add account to “${target?.name ?? 'this profile'}”`}
        </DialogTitle>
        <DialogDescription>
          {provider
            ? 'Your accounts stay in the profile you chose.'
            : creating
              ? 'Choose the first platform for this person or company. Your profile is created when the account connects.'
              : 'One account per platform. Choose another platform to add to this set.'}
        </DialogDescription>
      </DialogHeader>
      {checking ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking available connections…
        </p>
      ) : availability.isError ? (
        <div className="grid gap-2">
          <p role="alert" className="text-sm text-destructive">
            {settingsErrorMessage(availability.error)}
          </p>
          <Button type="button" variant="outline" onClick={() => void availability.refetch()}>
            Check again
          </Button>
        </div>
      ) : null}
      {!provider ? (
        <>
          {creating ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {intent.creationVisibility === 'PRIVATE' ? (
                <LockKeyhole className="size-3.5" aria-hidden />
              ) : (
                <Users className="size-3.5" aria-hidden />
              )}
              {intent.creationVisibility === 'PRIVATE'
                ? 'Private to you in this workspace'
                : 'Shared with this workspace'}
            </p>
          ) : null}
          <div className="grid gap-2" ref={picker}>
            {providers.map((item) => {
              const channel = channelForPlatform(item.id)
              const occupied =
                intent.operation !== 'RECONNECT' &&
                target?.accounts.some(
                  (account) => channelForPlatform(account.platform) === channel && channel !== null
                )
              return (
                <Button
                  key={item.id}
                  data-provider={item.id}
                  aria-label={`${item.label}${occupied ? ' Connected' : ''}`}
                  aria-describedby={
                    !occupied && catalog && !providerReady(catalog, item.id, true)
                      ? `provider-${item.id}-availability`
                      : undefined
                  }
                  disabled={occupied || !providerReady(catalog, item.id, true)}
                  variant="outline"
                  className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal py-2"
                  onClick={() => setProvider(item.id)}
                  type="button"
                >
                  {channel ? (
                    <ChannelIcon channel={channel} className="size-5" />
                  ) : (
                    <Newspaper className="size-5" aria-hidden />
                  )}
                  <span className="flex-1 text-left">
                    <span className="block">{item.label}</span>
                    {!occupied && catalog && !providerReady(catalog, item.id, true) ? (
                      <span
                        id={`provider-${item.id}-availability`}
                        className="block text-xs font-normal"
                      >
                        {providerUnavailableMessage(catalog, item.id)}
                      </span>
                    ) : null}
                  </span>
                  {occupied ? (
                    <span className="text-xs">Connected</span>
                  ) : (
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                  )}
                </Button>
              )
            })}
          </div>
        </>
      ) : !catalog ? null : !providerReady(catalog, provider, true) ? (
        <p role="status" className="text-sm text-muted-foreground">
          {providerUnavailableMessage(catalog, provider)}
        </p>
      ) : provider === 'bluesky' ? (
        <BlueskyForm intent={intent} target={target} />
      ) : (
        <ProviderForm
          key={provider}
          provider={provider}
          intent={intent}
          target={target}
          availability={catalog}
        />
      )}
      {provider ? (
        <Button type="button" variant="ghost" onClick={close}>
          {provider === 'bluesky' ? 'Cancel' : 'Close'}
        </Button>
      ) : null}
    </DialogContent>
  )
}

'use client'

import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { UsersIcon } from '@phosphor-icons/react/dist/ssr/Users'
import { useQuery } from '@tanstack/react-query'
import type { ChannelConnection, SocialAccountHealth } from 'screenshot-studio-backend-sdk'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { LocalTime } from '@/components/drafts/local-time'
import { Group, Pill, Section } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import {
  CONNECT_PROVIDERS,
  HEALTH_GUIDANCE,
  connectHref,
  useSocialSets,
} from '@/components/settings/social-sets/api'
import { useSocialSetScope } from '@/components/settings/social-sets/scope'
import {
  providerComingSoon,
  useConnectionAvailability,
} from '@/components/social-connections/availability'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { channelCapacitySchema } from '@/lib/api/contracts/social-availability'
import { socialSetSchema } from '@/lib/api/contracts/social-sets'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { getErrorMessage } from './settings-client'

/** The order platforms are listed in: most used first. */
const ORDER = [
  'x',
  'tiktok',
  'linkedin',
  'linkedin-page',
  'instagram-standalone',
  'threads',
  'youtube',
  'mastodon',
]

/** One row per platform the connect routes support, from the same registry the brand pages use. */
const ROWS = [...CONNECT_PROVIDERS].sort(
  (a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider)
)

/** Networks with no connection in the catalog yet. Bluesky joins them while its rollout flag is off. */
const NOT_YET = ['Facebook', 'Pinterest']

/** Platform names that are another row's platform. */
const ALIASES: Record<string, string> = {
  instagram: 'instagram-standalone',
  'mastodon-custom': 'mastodon',
  mastodoncustom: 'mastodon',
  twitter: 'x',
}

/** What a return trip from a provider tells the admin, keyed by the `connected` search parameter. */
const CONNECTED: Record<string, string> = {
  instagram: 'Instagram is connected. Approved Instagram posts can be scheduled to it.',
  'instagram-standalone':
    'Instagram is connected. Approved Instagram posts can be scheduled to it.',
  linkedin: 'LinkedIn is connected. Approved LinkedIn posts can be scheduled to it.',
  'linkedin-page': 'LinkedIn Page is connected. Approved LinkedIn posts can be scheduled to it.',
  mastodon: 'Mastodon is connected. Drafts can be scheduled to it.',
  threads: 'Threads is connected. Drafts can be scheduled to it.',
  tiktok: 'TikTok is connected. Approved TikTok posts can be scheduled to it.',
  x: 'X is connected. Approved X posts can be scheduled to it.',
  youtube: 'YouTube is connected. Approved YouTube posts can be scheduled to it.',
}

/** The help tip ID that remembers the banner was dismissed. */
const BANNER_TIP = 'channels-shared-accounts'

type Filter = 'all' | 'attention' | 'unassigned' | `brand:${string}`

/** An account's state on the page, from the backend's verified health. */
function healthOf(connection: ChannelConnection): SocialAccountHealth {
  return connection.health ?? (connection.status === 'ACTIVE' ? 'connected' : 'removed')
}

function needsReconnect(health: SocialAccountHealth): boolean {
  return ['reconnect_required', 'expired', 'unverified', 'permission_required'].includes(health)
}

/** The status in words, with its dot: green ready, amber needs a reconnect, red disconnected. */
function StatusDot({ health }: { health: SocialAccountHealth }) {
  const [tone, label] =
    health === 'connected'
      ? ['bg-[var(--success,#047857)]', 'Active']
      : needsReconnect(health)
        ? ['bg-amber-500', 'Needs reconnect']
        : ['bg-[var(--danger,#b91c1c)]', 'Disconnected']
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className={cn('size-2 rounded-full', tone)} />
      {label}
    </span>
  )
}

/** Where an account lives on its platform, when its handle says. */
function profileUrl(platform: string, handle: string | null | undefined): string | null {
  const name = handle?.replace(/^@/, '')
  if (!name) return null
  const row = ALIASES[platform] ?? platform
  if (row === 'mastodon') {
    const [user, server] = name.split('@')
    return user && server ? `https://${server}/@${user}` : null
  }
  const pages: Record<string, string> = {
    bluesky: `https://bsky.app/profile/${name}`,
    'instagram-standalone': `https://www.instagram.com/${name}`,
    threads: `https://www.threads.net/@${name}`,
    tiktok: `https://www.tiktok.com/@${name}`,
    x: `https://x.com/${name}`,
    youtube: `https://www.youtube.com/@${name}`,
  }
  return pages[row] ?? null
}

/** Initials for an avatar that has no picture. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

/**
 * The workspace's social accounts, one row per platform: each connected
 * account with its health, its publishing brand and a menu of the actions an
 * admin takes on it, then Connect, or Add another once the platform has one.
 */
export function ChannelConnections({ canManage }: { canManage: boolean }) {
  const trpcClient = useTRPCClient()
  const search = useSearchParams()
  const connected = search.get('connected')
  const scope = useSocialSetScope()
  const sets = useSocialSets()
  const availability = useConnectionAvailability()
  const { preferences, save } = usePreferences()
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>(() => {
    const brand = search.get('brand')
    return brand ? `brand:${brand}` : 'all'
  })
  const [showIds, setShowIds] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ChannelConnection | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // A new or removed account changes the count too.
  const capacity = useQuery({
    enabled: canManage && scope.ready,
    queryFn: ({ signal }) =>
      scope.request('/api/v1/social-connection-capacity', channelCapacitySchema, { signal }),
    queryKey: [...scope.key, 'capacity', connections?.length],
  }).data

  const load = useCallback(
    () =>
      trpcClient.channelConnection.list
        .query()
        .then((result) => {
          setConnections(result.connections.filter((connection) => connection.status === 'ACTIVE'))
          setError(null)
        })
        .catch((requestError: unknown) => setError(getErrorMessage(requestError))),
    [trpcClient]
  )
  useEffect(() => {
    if (canManage) void load()
  }, [canManage, load])

  // Brands are only there when the workspace has publishing brands; without them the page still works.
  const brands = useMemo(() => sets.data?.items ?? [], [sets.data])
  const brandOf = (connection: ChannelConnection) =>
    connection.socialSetId ? brands.find((set) => set.id === connection.socialSetId) : undefined
  const rowOf = (platform: string) => ALIASES[platform] ?? platform
  const comingSoon = (provider: string) => providerComingSoon(availability.data, provider)
  // Platforms that can connect come first; the sort is stable, so each group keeps ORDER.
  const shown = [...ROWS].sort(
    (a, b) => Number(comingSoon(a.provider)) - Number(comingSoon(b.provider))
  )
  const notYet = comingSoon('bluesky') ? [...NOT_YET, 'Bluesky'] : NOT_YET
  const attention = (connections ?? []).filter((connection) => needsReconnect(healthOf(connection)))
  const visible = (connection: ChannelConnection) =>
    filter === 'all' ||
    (filter === 'attention' && needsReconnect(healthOf(connection))) ||
    (filter === 'unassigned' && !connection.socialSetId) ||
    filter === `brand:${connection.socialSetId}`
  const accountsFor = (platform: string) =>
    (connections ?? []).filter(
      (connection) => rowOf(connection.platform) === platform && visible(connection)
    )
  // Accounts on a platform with no Connect row here, such as Bluesky, which connects from a brand.
  const others = (connections ?? []).filter(
    (connection) =>
      !ROWS.some((row) => row.platform === rowOf(connection.platform)) && visible(connection)
  )

  // Back from a provider: show the new account, and offer a brand when it has none.
  useEffect(() => {
    if (!connected || !connections) return
    const row = ALIASES[connected] ?? connected
    const newest = connections
      .filter((connection) => rowOf(connection.platform) === row)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    document.getElementById(`channels-${row}`)?.scrollIntoView({ block: 'center' })
    if (!newest) return
    setFresh(newest.id)
    if (!newest.socialSetId && brands.length) setMenu(newest.id)
    const timer = setTimeout(() => setFresh(null), 2000)
    return () => clearTimeout(timer)
    // Once per return trip, when the accounts first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connections === null])

  const assign = async (connection: ChannelConnection, setId: string) => {
    try {
      await scope.request(
        `/api/v1/social-sets/${encodeURIComponent(setId)}/accounts/${encodeURIComponent(connection.id)}`,
        socialSetSchema,
        { method: 'POST' }
      )
      await Promise.all([load(), sets.refetch()])
      toast.success('Account added to the publishing brand.')
    } catch (assignError) {
      toast.error(settingsErrorMessage(assignError))
    }
  }

  const refresh = async (target: ChannelConnection) => {
    setRefreshing(true)
    try {
      await trpcClient.channelConnection.refresh.mutate({ connectionId: target.id })
      await load()
      toast.success('Account refreshed.')
    } catch (refreshError) {
      toast.error(getErrorMessage(refreshError))
    } finally {
      setRefreshing(false)
    }
  }

  const reconnectHref = (connection: ChannelConnection) => {
    const provider = ROWS.find((row) => row.platform === rowOf(connection.platform))?.provider
    // The start route refuses a provider the catalog says is not ready.
    if (!provider || comingSoon(provider)) return null
    return connection.socialSetId
      ? connectHref(provider, connection.socialSetId, connection.id)
      : `/integrations/social/${encodeURIComponent(provider)}/start`
  }

  const chip = (connection: ChannelConnection) => {
    const health = healthOf(connection)
    const name = connection.displayName || connection.handle || connection.externalAccountId
    const brand = brandOf(connection)
    const profile = profileUrl(connection.platform, connection.handle)
    const reconnect = reconnectHref(connection)
    const platform = rowOf(connection.platform)
    const open = (connection.socialSetId ? [] : brands).map((set) => ({
      set,
      taken: set.accounts.some((account) => rowOf(account.platform) === platform),
    }))
    // Another person's private brand is not in the list; an unread list says nothing.
    const place =
      brand?.name ??
      (connection.socialSetId ? (sets.data ? 'Private brand' : null) : 'Not in any brand')
    return (
      <div
        className={cn(
          'flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card py-1 pr-1 pl-2 transition-shadow',
          fresh === connection.id && 'ring-2 ring-ring'
        )}
        data-testid="channel-account"
        key={connection.id}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Avatar className="size-6">
            {connection.avatarUrl ? <AvatarImage alt="" src={connection.avatarUrl} /> : null}
            <AvatarFallback className="text-[10px]">{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 text-sm">
            <span className="truncate">{name}</span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
              <StatusDot health={health} />
              {place ? (
                <>
                  <span aria-hidden>·</span>
                  {brand ? (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full ring-1 ring-foreground/15"
                      style={{ backgroundColor: brand.color }}
                    />
                  ) : null}
                  <span className="truncate">{place}</span>
                </>
              ) : null}
            </span>
            {showIds ? (
              <span className="truncate text-xs text-muted-foreground">
                {connection.handle ? `@${connection.handle} · ` : ''}
                {connection.id}
              </span>
            ) : null}
          </span>
        </span>
        {canManage && reconnect ? (
          needsReconnect(health) ? (
            <Button asChild className="h-6 rounded-full px-2 text-xs" size={null} variant="outline">
              <a href={reconnect}>Reconnect</a>
            </Button>
          ) : (
            <a
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              href={reconnect}
            >
              Reconnect if posting fails
            </a>
          )
        ) : null}
        <DropdownMenu
          onOpenChange={(next) => setMenu(next ? connection.id : null)}
          open={menu === connection.id}
        >
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`${name}: account actions`}
              className="size-6 shrink-0 rounded-full text-muted-foreground"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <DotsThreeIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel className="grid gap-0.5">
              <span>{name}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {HEALTH_GUIDANCE[health]}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {profile ? (
              <DropdownMenuItem asChild>
                <a href={profile} rel="noreferrer" target="_blank">
                  Open profile
                </a>
              </DropdownMenuItem>
            ) : null}
            {canManage && reconnect ? (
              <DropdownMenuItem asChild>
                {/* A plain link: prefetching the start route would begin an OAuth flow. */}
                <a href={reconnect}>Reconnect</a>
              </DropdownMenuItem>
            ) : null}
            {canManage ? (
              <DropdownMenuItem
                className="grid gap-0.5"
                disabled={refreshing}
                onSelect={() => void refresh(connection)}
              >
                Refresh name and picture
                <span className="text-xs text-muted-foreground">
                  Last changed <LocalTime value={connection.updatedAt ?? connection.createdAt} />
                </span>
              </DropdownMenuItem>
            ) : null}
            {canManage && open.length ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Assign to brand</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    onValueChange={(setId) => void assign(connection, setId)}
                    value=""
                  >
                    {open.map(({ set, taken }) => (
                      <DropdownMenuRadioItem disabled={taken} key={set.id} value={set.id}>
                        <span
                          aria-hidden
                          className="size-2 rounded-full"
                          style={{ backgroundColor: set.color }}
                        />
                        {set.name}
                        {taken ? (
                          <span className="ml-auto text-xs text-muted-foreground">Has one</span>
                        ) : null}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {brand ? (
              <DropdownMenuItem asChild>
                <a href={socialSetHref(brand.id)}>Open {brand.name}</a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onSelect={() =>
                void navigator.clipboard
                  .writeText(connection.id)
                  .then(() => toast.success('Account ID copied.'))
              }
            >
              Copy ID
            </DropdownMenuItem>
            {canManage ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setRemoving(connection)} variant="destructive">
                  Remove…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  const removingBrand = removing ? brandOf(removing) : undefined
  const removingName = removing
    ? removing.displayName || removing.handle || removing.externalAccountId
    : ''

  return (
    <Section
      description="Connect an account here once; each publishing brand posts from the accounts assigned to it."
      title="Connected accounts"
    >
      {connected && CONNECTED[connected] ? (
        <Alert className="mb-4">
          <AlertDescription>{CONNECTED[connected]}</AlertDescription>
        </Alert>
      ) : null}
      {preferences && !preferences.dismissedTips.includes(BANNER_TIP) ? (
        <Alert className="mb-4">
          <UsersIcon aria-hidden />
          <AlertTitle>Connecting for the workspace</AlertTitle>
          <AlertDescription>
            <p>
              Accounts you connect here are shared with everyone in this workspace. Assign each one
              to a publishing brand to post from it.
            </p>
            <Button
              className="mt-2 h-auto p-0"
              onClick={() => void save({ dismissTip: BANNER_TIP })}
              size={null}
              type="button"
              variant="link"
            >
              Got it
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Group>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <h3 className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
            Accounts
            {attention.length ? <Pill tone="yellow">{attention.length} need attention</Pill> : null}
            {capacity && capacity.limit !== null ? (
              <Pill tone={capacity.held >= capacity.limit ? 'yellow' : undefined}>
                {capacity.held} of {capacity.limit} accounts
              </Pill>
            ) : null}
          </h3>
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <Label className="flex items-center gap-2 text-sm font-normal">
              Show IDs
              <Switch checked={showIds} onCheckedChange={setShowIds} />
            </Label>
            <Select onValueChange={(value) => setFilter(value as Filter)} value={filter}>
              <SelectTrigger aria-label="Show accounts" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="all">All accounts</SelectItem>
                <SelectItem value="attention">Needs attention</SelectItem>
                <SelectItem value="unassigned">Not in any brand</SelectItem>
                {brands.map((set) => (
                  <SelectItem key={set.id} value={`brand:${set.id}`}>
                    {set.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!canManage ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Only owners and admins can connect and manage accounts.
          </p>
        ) : connections === null ? (
          error ? null : (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading channels…</p>
          )
        ) : (
          <>
            {shown.map((row) => {
              const accounts = accountsFor(row.platform)
              const channel = channelForPlatform(row.platform)
              const unavailable = comingSoon(row.provider)
              // Every account counts here, whatever the filter hides.
              const hasAccount = (connections ?? []).some(
                (connection) => rowOf(connection.platform) === row.platform
              )
              return (
                <div
                  className="grid gap-3 px-4 py-3 sm:grid-cols-[150px_minmax(0,1fr)_170px] sm:items-center"
                  data-testid="channel-platform"
                  id={`channels-${row.platform}`}
                  key={row.provider}
                >
                  <div className="flex items-center gap-2">
                    {channel ? (
                      <ChannelIcon channel={channel} className="size-7 shrink-0 text-foreground" />
                    ) : null}
                    <span className="text-sm font-medium">{row.label}</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {accounts.length ? (
                      accounts.map(chip)
                    ) : unavailable ? null : (
                      <span className="text-sm text-muted-foreground">
                        {filter === 'all' ? 'No accounts yet' : 'None match'}
                      </span>
                    )}
                  </div>
                  {!unavailable ? (
                    <Button
                      asChild
                      className="w-full"
                      size="sm"
                      variant={hasAccount ? 'outline' : 'default'}
                    >
                      {/* A plain link, not next/link: prefetching the start route would begin an OAuth flow. */}
                      <a
                        aria-label={hasAccount ? `Add another ${row.label} account` : undefined}
                        href={`/integrations/social/${row.provider}/start`}
                      >
                        {hasAccount ? 'Add another' : `Connect ${row.label}`}
                      </a>
                    </Button>
                  ) : hasAccount ? null : (
                    <span className="text-sm text-muted-foreground sm:text-center">Coming soon</span>
                  )}
                </div>
              )
            })}
            {others.length ? (
              <div className="grid gap-3 px-4 py-3 sm:grid-cols-[150px_minmax(0,1fr)_170px] sm:items-center">
                <span className="text-sm font-medium">
                  Other accounts
                  <span className="block text-xs font-normal text-muted-foreground">
                    Connect these from a publishing brand.
                  </span>
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">{others.map(chip)}</div>
              </div>
            ) : null}
            <p className="px-4 py-3 text-sm text-muted-foreground">
              Coming soon: {notYet.join(', ')}.
            </p>
          </>
        )}
      </Group>
      {error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <ConfirmDialog
        confirmLabel="Remove account"
        description={
          removing ? (
            <>
              <p>
                {removingName} stops publishing from Shots
                {removingBrand
                  ? ` and leaves ${removingBrand.name}`
                  : removing.socialSetId
                    ? ' and leaves its private brand'
                    : ''}
                .
              </p>
              <p>
                {removing.queuedPosts === undefined
                  ? 'Any posts scheduled on it are cancelled.'
                  : removing.queuedPosts
                    ? `${removing.queuedPosts} scheduled ${removing.queuedPosts === 1 ? 'post is' : 'posts are'} cancelled.`
                    : 'No scheduled posts are affected.'}{' '}
                {removing.queuedPosts && removingBrand ? (
                  <>
                    <a
                      className="underline underline-offset-2"
                      href={`/publish?${new URLSearchParams({ set: removingBrand.id, account: removing.id, tab: 'queue' })}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      See this account’s queue
                    </a>
                    .{' '}
                  </>
                ) : null}
                Published posts and their receipts stay.
              </p>
            </>
          ) : null
        }
        destructive
        onConfirm={async () => {
          if (!removing) return null
          try {
            await trpcClient.channelConnection.remove.mutate({ connectionId: removing.id })
            await Promise.all([load(), sets.refetch()])
            toast.success(`${removingName} was removed.`)
            return null
          } catch (removeError) {
            return getErrorMessage(removeError)
          }
        }}
        onOpenChange={(next) => {
          if (!next) setRemoving(null)
        }}
        open={removing !== null}
        title={`Remove ${removingName}?`}
      />
    </Section>
  )
}

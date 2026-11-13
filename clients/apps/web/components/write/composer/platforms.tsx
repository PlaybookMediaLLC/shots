'use client'

import { WarningIcon } from '@phosphor-icons/react/dist/ssr/Warning'
import * as React from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { overflowAt, serializeDraft } from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from '@/lib/write/capabilities'
import type {
  DraftChannel,
  DraftKind,
  PlateBody,
  PlatformVersions,
  VersionOptions,
} from '@/lib/write/document'
import { bodyPosts, forkVersion, mainAfterToggle, primaryChanged, resyncVersion, versionFor } from '@/lib/write/versions'
import { POST_COLUMN } from '@/components/drafts/layout'
import { platformRefusal } from '@/lib/write/platform-rules'
import { cn } from '@/lib/utils'
import { healthLabel } from '../sets'
import { optionsSummary } from './video-options'
import type { WriteSet } from '../write-context'
import { CONNECT_PROVIDERS } from '@/components/settings/social-sets/api'
import {
  providerComingSoon,
  useConnectionAvailability,
} from '@/components/social-connections/availability'

/** A set's account as the composer shows it. */
export type ComposerAccount = WriteSet['accounts'][number]

/**
 * The platforms of a draft (RFC 025). The tab being edited, whether a
 * platform publishes, whether its account is healthy, and whether its
 * version follows the primary are four separate things: changing the tab
 * changes nothing that is saved. Each tab carries its own publish switch.
 */
export function PlatformTabs({
  accounts,
  active,
  blocked = [],
  canEdit,
  enabled,
  kind,
  onSelect,
  onToggle,
  options,
  over = [],
  primary,
  value,
  versions,
}: {
  accounts: ComposerAccount[]
  active: DraftChannel
  /** Platforms with something to fix before they can publish. */
  blocked?: DraftChannel[]
  canEdit: boolean
  enabled: string[]
  kind: DraftKind
  onSelect: (channel: DraftChannel) => void
  onToggle: (accountId: string, on: boolean) => void
  /** Platforms whose text runs over their limit; each tab shows only its own count. */
  over?: DraftChannel[]
  /** The edited platform's options chip, at the row's end. */
  options?: React.ReactNode
  primary: DraftChannel
  /** The primary's text, which a platform's own text is told apart from. */
  value: PlateBody
  versions: PlatformVersions
}) {
  const channels = allChannels(accounts, primary)
  return (
    // The row wraps rather than scrolls, so no tab or options chip is cut off at the edge.
    <div className="flex flex-wrap items-center gap-2 px-4 py-3" data-testid="platform-tabs">
      <div aria-label="Platforms" className="flex flex-wrap items-center gap-2" role="group">
        {channels.map((channel) => {
          const account = accountOn(accounts, enabled, channel)
          const publishing = account ? enabled.includes(account.id) : false
          const version = versionFor(versions, channel)
          const mode = channel === primary ? 'primary' : version.mode
          // Forked but word for word the same is not yet its own text.
          const own =
            mode === 'manual' &&
            serializeDraft(version.body ?? [], channel).caption !==
              serializeDraft(value, channel).caption
          const refusal = platformRefusal(channel, kind, publishing, enabled.length)
          return (
            <div
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border pe-2 text-ui transition-colors',
                active === channel
                  ? 'border-input bg-foreground/[0.08] text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
              key={channel}
            >
              <Button
                aria-pressed={active === channel}
                className="flex h-full items-center gap-2 ps-3"
                data-testid={`platform-tab-${channel}`}
                onClick={() => onSelect(channel)}
                size={null}
                type="button"
                variant="custom"
              >
                <ChannelIcon channel={channel} />
                {CHANNEL_META[channel].label}
                {/* A synced version is the default, so only main and own text are named. */}
                {mode === 'primary' ? (
                  <span className="text-label text-muted-foreground">Main</span>
                ) : own ? (
                  <span className="rounded-full bg-amber-400/15 px-1.5 text-label text-amber-700 dark:text-amber-200">
                    Own text
                  </span>
                ) : null}
                {over.includes(channel) ? (
                  <span
                    aria-label="Over its character limit"
                    className="size-1.5 rounded-full bg-red-500"
                    data-testid={`platform-over-${channel}`}
                    role="img"
                  />
                ) : blocked.includes(channel) ? (
                  <span
                    aria-label="Needs a fix before it can publish"
                    className="size-1.5 rounded-full bg-red-500"
                    data-testid={`platform-blocked-${channel}`}
                    role="img"
                  />
                ) : null}
                {!account ? (
                  <span className="text-label text-muted-foreground">· not connected</span>
                ) : null}
                {account && account.health !== 'connected' ? (
                  <span className="text-amber-700 dark:text-amber-300" title={healthLabel(account.health)}>
                    <WarningIcon aria-label={healthLabel(account.health)} className="size-3.5" />
                  </span>
                ) : null}
              </Button>
              {account ? (
                <span className="inline-flex" title={refusal ?? undefined}>
                  <Switch
                    aria-label={`Publish to ${CHANNEL_META[channel].label}`}
                    checked={publishing}
                    disabled={!canEdit || refusal !== null}
                    onCheckedChange={(checked) => onToggle(account.id, checked === true)}
                  />
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
      {options ? <div className="ml-auto max-w-full min-w-0">{options}</div> : null}
    </div>
  )
}

/**
 * The edited platform's options in a few words, such as "TikTok: Only me ·
 * comments on". It opens them beside the draft, so no form sits above the text.
 */
export function OptionsChip({
  blocked,
  channel,
  onClick,
  open,
  options,
}: {
  /** Something in these options blocks scheduling. */
  blocked: boolean
  channel: DraftChannel
  onClick: () => void
  open: boolean
  options: VersionOptions
}) {
  const summary = optionsSummary(channel, options)
  const label = CHANNEL_META[channel].label
  const text = summary ? `${label}: ${summary}` : `${label} options`
  return (
    <Button
      aria-expanded={open}
      className={cn(
        'h-auto min-h-8 max-w-full gap-1.5 text-ui whitespace-normal text-left',
        blocked && 'text-amber-700 dark:text-amber-300'
      )}
      data-testid="options-chip"
      onClick={onClick}
      size="sm"
      title="Post options for this platform"
      variant="outline"
    >
      {blocked ? <span aria-hidden className="size-1.5 rounded-full bg-amber-500" /> : null}
      {text}
    </Button>
  )
}

/**
 * A draft after turning one account on or off: one account per platform, and
 * the main platform handed on if this one was it.
 */
export function toggledPlatforms(
  accounts: ComposerAccount[],
  account: ComposerAccount,
  on: boolean,
  draft: { enabled: string[]; primary: DraftChannel; versions: PlatformVersions }
): { channelConnectionIds: string[]; primaryPlatform: DraftChannel } {
  const channelConnectionIds = on
    ? [
        ...draft.enabled.filter(
          (id) => accounts.find((item) => item.id === id)?.channel !== account.channel
        ),
        account.id,
      ]
    : draft.enabled.filter((id) => id !== account.id)
  return {
    channelConnectionIds,
    primaryPlatform: mainAfterToggle(
      draft.primary,
      accounts.filter((item) => channelConnectionIds.includes(item.id)).map((item) => item.channel),
      draft.versions
    ),
  }
}

/** The tabs a draft shows: its primary, then each enabled platform, once. */
export function tabChannels(
  accounts: ComposerAccount[],
  enabled: string[],
  primary: DraftChannel
): DraftChannel[] {
  const channels: DraftChannel[] = [primary]
  for (const account of accounts) {
    if (enabled.includes(account.id) && !channels.includes(account.channel))
      channels.push(account.channel)
  }
  return channels
}

/** Every tab a draft can show: its primary, then each connected account's platform, once. */
export function allChannels(accounts: ComposerAccount[], primary: DraftChannel): DraftChannel[] {
  return [...new Set([primary, ...accounts.map((account) => account.channel)])]
}

/** The account a platform's tab acts on: the one publishing, or else its first. */
function accountOn(accounts: ComposerAccount[], enabled: string[], channel: DraftChannel) {
  const own = accounts.filter((account) => account.channel === channel)
  return own.find((account) => enabled.includes(account.id)) ?? own[0]
}

/** Connect another account, from wherever the composer offers it. */
export function ConnectMenu({
  accounts,
  label = 'Connect account',
  onConnect,
}: {
  accounts: ComposerAccount[]
  label?: string
  onConnect: (provider: string) => Promise<void>
}) {
  const availability = useConnectionAvailability()
  const providers = CONNECT_PROVIDERS.filter(
    (provider) =>
      !providerComingSoon(availability.data, provider.provider) &&
      !accounts.some(
        (account) => account.platform === provider.platform && account.health === 'connected'
      )
  )
  if (providers.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {providers.map((provider) => (
          <DropdownMenuItem key={provider.provider} onSelect={() => void onConnect(provider.provider)}>
            Connect {provider.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The tab being edited: which account it posts from, whether that account is
 * healthy, and whether its text follows the main platform.
 */
export function ActivePlatform({
  accounts,
  active,
  canEdit,
  defaultsHref,
  draftVersion,
  enabled,
  kind,
  onChange,
  onConnect,
  onResync,
  onToggle,
  primary,
  value,
  versions,
}: {
  accounts: ComposerAccount[]
  active: DraftChannel
  canEdit: boolean
  /** The brand's new-draft settings, where its default platforms are chosen. */
  defaultsHref?: string
  draftVersion: number
  enabled: string[]
  kind: DraftKind
  onChange: (change: { primaryPlatform?: DraftChannel; versions?: PlatformVersions }) => void
  onConnect?: (provider: string) => Promise<void>
  onResync: (channel: DraftChannel) => void
  onToggle: (accountId: string, on: boolean) => void
  primary: DraftChannel
  value: PlateBody
  versions: PlatformVersions
}) {
  const own = accounts.filter((account) => account.channel === active)
  const account = accountOn(accounts, enabled, active)
  if (!account) return null
  const on = enabled.includes(account.id)
  const version = versionFor(versions, active)
  const refusal = platformRefusal(active, kind, on, enabled.length)
  return (
    <div
      className="mx-4 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
      data-testid="active-platform"
    >
      {own.length > 1 ? (
        <Select
          disabled={!canEdit}
          onValueChange={(id) => onToggle(id, true)}
          value={account.id}
        >
          <SelectTrigger aria-label={`${CHANNEL_META[active].label} account`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {own.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.displayName ?? item.handle ?? CHANNEL_META[active].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <span>
        {own.length > 1 ? '' : `${account.displayName ?? CHANNEL_META[active].label} · `}
        {account.handle ? `@${account.handle} · ` : ''}
        {healthLabel(account.health)}
        {active === 'x'
          ? account.xCaptionLimit === 25_000
            ? ' · longer posts verified'
            : ' · standard post limit'
          : ''}
      </span>
      {account.health !== 'connected' ? (
        <a className="text-amber-700 underline dark:text-amber-300" href="/settings/channels">
          Reconnect in workspace settings
        </a>
      ) : null}
      {refusal ? <span>{refusal}</span> : null}
      {on && active !== primary && canEdit ? (
        <span className="flex flex-wrap items-center gap-2">
          <span>Text:</span>
          <Button
            aria-pressed={version.mode === 'synced'}
            className={cn(
              'rounded-md border px-2 py-1',
              version.mode === 'synced'
                ? 'border-sky-400/50 text-sky-700 dark:text-sky-200'
                : 'border-border text-muted-foreground'
            )}
            onClick={() => version.mode === 'manual' && onResync(active)}
            size={null}
            type="button"
            variant="custom"
          >
            Use main version ({CHANNEL_META[primary].label})
          </Button>
          <Button
            aria-pressed={version.mode === 'manual'}
            className={cn(
              'rounded-md border px-2 py-1',
              version.mode === 'manual'
                ? 'border-amber-400/50 text-amber-700 dark:text-amber-200'
                : 'border-border text-muted-foreground'
            )}
            onClick={() =>
              version.mode === 'synced' &&
              onChange({
                versions: forkVersion(
                  versions,
                  active,
                  value,
                  draftVersion,
                  Boolean(CAPABILITIES[active].thread)
                ),
              })
            }
            size={null}
            type="button"
            variant="custom"
          >
            Its own text
          </Button>
          {version.mode === 'synced' && refusal === null ? (
            <Button
              className="hover:text-foreground"
              onClick={() => onChange({ primaryPlatform: active })}
              size={null}
              type="button"
              variant="custom"
            >
              Make main
            </Button>
          ) : null}
        </span>
      ) : null}
      <span className="ms-auto flex items-center gap-3">
        {defaultsHref ? (
          <SidebarLink
            className="underline underline-offset-2 hover:text-foreground"
            href={defaultsHref}
          >
            Change default platforms
          </SidebarLink>
        ) : null}
        {onConnect ? <ConnectMenu accounts={accounts} onConnect={onConnect} /> : null}
      </span>
    </div>
  )
}

/** Going back to the main version discards this platform's own text, so it asks first. */
export function ResyncDialog({
  channel,
  onClose,
  onResynced,
  primary,
  versions,
}: {
  channel: DraftChannel | null
  onClose: () => void
  onResynced: (versions: PlatformVersions) => void
  primary: DraftChannel
  versions: PlatformVersions
}) {
  const orphaned = channel ? resyncVersion(versions, channel).orphaned : []
  return (
    <AlertDialog onOpenChange={(open) => !open && onClose()} open={channel !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Sync {channel ? CHANNEL_META[channel].label : ''} with {CHANNEL_META[primary].label}{' '}
            again?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its own text is replaced by {CHANNEL_META[primary].label}’s from now on. A backup keeps
            the current text.
            {orphaned.length > 0
              ? ` ${orphaned.length} comment thread${orphaned.length === 1 ? '' : 's'} on its text will lose their anchor and show as resolved-orphaned.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep its own text</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (channel) onResynced(resyncVersion(versions, channel).versions)
              onClose()
            }}
          >
            Replace with {CHANNEL_META[primary].label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * A synced version: what it will post, read-only, and the way to give it its
 * own text. A manual version whose primary moved on says so and offers a
 * comparison. A platform switched off for this post says only that: it
 * publishes nothing, so no notice about how its text is built applies.
 */
export function SyncedVersion({
  channel,
  header,
  limit,
  onFork,
  onSplit,
  primary,
  publishing = true,
  value,
}: {
  channel: DraftChannel
  /** The account's avatar and name, as the editor draws them over each post. */
  header: React.ReactNode
  limit: number
  onFork?: () => void
  /** Give this platform its own text, split into posts that fit. */
  onSplit?: () => void
  primary: DraftChannel
  /** Whether this platform's switch is on for this post. */
  publishing?: boolean
  value: PlateBody
}) {
  const posts = serializeDraft(value, channel).posts
  const hasPoll = bodyPosts(value).some((post) => post.settings.poll)
  if (!publishing)
    return (
      <div className="py-6" data-testid={`synced-version-${channel}`}>
        <div className={cn('mb-4', POST_COLUMN)}>
          <p
            className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
            data-testid={`platform-off-${channel}`}
          >
            {CHANNEL_META[channel].label} is switched off for this post, so nothing is sent there.
            Turn its switch on above to see what it would publish.
          </p>
        </div>
      </div>
    )
  return (
    <div className="py-6" data-testid={`synced-version-${channel}`}>
      <div className={cn('mb-4', POST_COLUMN)}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-foreground/[0.02] px-3 py-2 text-xs text-muted-foreground">
        <span className="flex-1">
          {CHANNEL_META[channel].label} follows {CHANNEL_META[primary].label}: what you write there
          appears here
          {CAPABILITIES[channel].thread ? ', post by post.' : ', joined into one post.'}
        </span>
        {onFork ? (
          <Button onClick={onFork} size="sm" type="button" variant="outline">
            Edit for {CHANNEL_META[channel].label} independently
          </Button>
        ) : null}
      </div>
      {hasPoll && !CAPABILITIES[channel].poll ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {CHANNEL_META[channel].label} does not take polls, so the poll is not posted here.
        </p>
      ) : null}
      </div>
      {posts.length === 0 ? (
        <div className={cn('mb-3', POST_COLUMN)}>
          {header}
          <p className="mt-1 text-sm text-muted-foreground">Nothing written yet.</p>
        </div>
      ) : null}
      {posts.map((post, index) => {
        const over = post.length > limit ? overflowAt(channel, post.caption, limit) : post.caption.length
        return (
          <article className={cn('mb-5', POST_COLUMN)} key={index}>
            {header}
            <p className="mt-1 whitespace-pre-wrap break-words text-body leading-relaxed text-foreground">
              {post.caption.slice(0, over)}
              {over < post.caption.length ? (
                <mark className="rounded-sm bg-destructive/15 text-inherit" data-testid="over-limit-text">
                  {post.caption.slice(over)}
                </mark>
              ) : null}
            </p>
            {post.length > limit && onSplit ? (
              <Button className="mt-1" onClick={onSplit} size="sm" type="button" variant="outline">
                Split into thread
              </Button>
            ) : null}
          </article>
        )
      })}
    </div>
  )
}

/** A manual version's notice: edited on its own, and whether the primary changed since. */
export function ManualVersionNotice({
  channel,
  onCompare,
  onResync,
  primary,
  value,
  versions,
}: {
  channel: DraftChannel
  onCompare: () => void
  onResync?: () => void
  primary: DraftChannel
  value: PlateBody
  versions: PlatformVersions
}) {
  const changed = primaryChanged(versionFor(versions, channel), value, channel)
  return (
    <div
      className={cn(
        'mx-auto mt-3 flex max-w-2xl flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        changed
          ? 'border-amber-400/30 bg-amber-400/[0.05] text-amber-700 dark:text-amber-100'
          : 'border-border text-muted-foreground'
      )}
      data-testid={`manual-version-${channel}`}
    >
      <span className="flex-1">
        {changed
          ? `${CHANNEL_META[primary].label} changed since you wrote this version. Your ${CHANNEL_META[channel].label} text is kept.`
          : `${CHANNEL_META[channel].label} has its own text: edits to ${CHANNEL_META[primary].label} do not change it.`}
      </span>
      <Button onClick={onCompare} size="sm" type="button" variant="ghost">
        Compare
      </Button>
      {onResync ? (
        <Button onClick={onResync} size="sm" type="button" variant="ghost">
          Sync again…
        </Button>
      ) : null}
    </div>
  )
}

/** The primary's version for a channel beside the channel's own, to decide what to keep. */
export function CompareDialog({
  channel,
  onClose,
  primary,
  value,
  versions,
}: {
  channel: DraftChannel
  onClose: () => void
  primary: DraftChannel
  value: PlateBody
  versions: PlatformVersions
}) {
  const fromPrimary = serializeDraft(value, channel).caption
  const own = serializeDraft(versionFor(versions, channel).body ?? [], channel).caption
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare {CHANNEL_META[channel].label} versions</DialogTitle>
          <DialogDescription>
            Left: what {CHANNEL_META[primary].label}’s text would post on{' '}
            {CHANNEL_META[channel].label}. Right: {CHANNEL_META[channel].label}’s own text, which is
            what publishes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label className="grid gap-1 text-xs text-muted-foreground">
            From {CHANNEL_META[primary].label}
            <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-sans text-sm text-foreground">
              {fromPrimary || ' '}
            </pre>
          </Label>
          <Label className="grid gap-1 text-xs text-muted-foreground">
            {CHANNEL_META[channel].label}’s own (publishes)
            <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-sans text-sm text-foreground">
              {own || ' '}
            </pre>
          </Label>
        </div>
        <DialogFooter>
          <Button onClick={onClose} type="button">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

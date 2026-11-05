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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from '@/lib/write/capabilities'
import type {
  DraftChannel,
  DraftKind,
  PlateBody,
  PlatformVersions,
  VersionOptions,
} from '@/lib/write/document'
import { forkVersion, primaryChanged, resyncVersion, versionFor } from '@/lib/write/versions'
import { cn } from '@/lib/utils'
import { healthLabel } from '../sets'
import { optionsSummary } from './video-options'
import type { WriteSet } from '../write-context'
import { CONNECT_PROVIDERS } from '@/components/settings/social-sets/api'

/** A set's account as the composer shows it. */
export type ComposerAccount = WriteSet['accounts'][number]

/**
 * The platforms of a draft (RFC 025). The tab being edited, whether a
 * platform publishes, whether its account is healthy, and whether its
 * version follows the primary are four separate things: changing the tab
 * changes nothing that is saved.
 */
export function PlatformTabs({
  accounts,
  active,
  enabled,
  onManage,
  onSelect,
  options,
  over = [],
  primary,
  versions,
}: {
  accounts: ComposerAccount[]
  active: DraftChannel
  enabled: string[]
  onManage?: () => void
  onSelect: (channel: DraftChannel) => void
  /** Platforms whose text runs over their limit; each tab shows only its own count. */
  over?: DraftChannel[]
  /** The edited platform's options chip, at the row's end. */
  options?: React.ReactNode
  primary: DraftChannel
  versions: PlatformVersions
}) {
  const channels = tabChannels(accounts, enabled, primary)
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-4 py-3" data-testid="platform-tabs">
      <div aria-label="Platform being edited" className="flex items-center gap-2" role="tablist">
        {channels.map((channel) => {
          const account = accounts.find((item) => item.channel === channel)
          const publishing = account ? enabled.includes(account.id) : false
          const mode = channel === primary ? 'primary' : versionFor(versions, channel).mode
          return (
            <Button
              aria-selected={active === channel}
              className={cn(
                'flex h-8 items-center gap-2 rounded-md border px-3 text-ui transition-colors',
                active === channel
                  ? 'border-input bg-foreground/[0.08] text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
              data-testid={`platform-tab-${channel}`}
              key={channel}
              onClick={() => onSelect(channel)}
              role="tab"
              size={null}
              type="button"
              variant="custom"
            >
              <ChannelIcon channel={channel} />
              {CHANNEL_META[channel].label}
              {/* A synced version is the default, so only main and own text are named. */}
              {mode === 'primary' ? (
                <span className="text-label text-muted-foreground">Main</span>
              ) : mode === 'manual' ? (
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
              ) : null}
              {!publishing ? (
                <span className="text-label text-muted-foreground">
                  {account ? '· off' : '· not connected'}
                </span>
              ) : null}
              {account && account.health !== 'connected' ? (
                <span className="text-amber-700 dark:text-amber-300" title={healthLabel(account.health)}>
                  <WarningIcon aria-label={healthLabel(account.health)} className="size-3.5" />
                </span>
              ) : null}
            </Button>
          )
        })}
      </div>
      {onManage ? (
        <Button
          className="ml-1 text-ui text-muted-foreground hover:text-foreground"
          onClick={onManage}
          size={null}
          type="button"
          variant="custom"
        >
          Manage platforms
        </Button>
      ) : null}
      {options ? <div className="ml-auto shrink-0">{options}</div> : null}
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
        'h-8 gap-1.5 text-ui',
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

/**
 * Turn platforms on and off for publication, see each account's health,
 * choose the primary, and choose which versions follow it. Turning a
 * version back to synced discards its own text, so it asks first.
 */
export function ManagePlatformsDialog({
  accounts,
  draftVersion,
  enabled,
  kind,
  onChange,
  onClose,
  onConnect,
  onPreview,
  defaultsHref,
  primary,
  value,
  versions,
}: {
  accounts: ComposerAccount[]
  /** The brand's new-draft settings, where its default platforms are chosen. */
  defaultsHref?: string
  draftVersion: number
  enabled: string[]
  kind: DraftKind
  onChange: (change: {
    channelConnectionIds?: string[]
    primaryPlatform?: DraftChannel
    versions?: PlatformVersions
  }) => void
  onClose: () => void
  onConnect?: (provider: string) => Promise<void>
  /** Show a platform's post in the preview beside the draft. */
  onPreview?: (channel: DraftChannel) => void
  primary: DraftChannel
  value: PlateBody
  versions: PlatformVersions
}) {
  const [resync, setResync] = React.useState<DraftChannel | null>(null)
  const orphaned = resync ? resyncVersion(versions, resync).orphaned : []
  const toggle = (account: ComposerAccount, on: boolean) => {
    const next = on
      ? [
          ...enabled.filter(
            (id) => accounts.find((item) => item.id === id)?.channel !== account.channel
          ),
          account.id,
        ]
      : enabled.filter((id) => id !== account.id)
    onChange({ channelConnectionIds: next })
  }
  const exclusive = kind === 'article' || kind === 'reply'
  return (
    <>
      <Dialog onOpenChange={(open) => !open && onClose()} open>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Draft platforms</DialogTitle>
            <DialogDescription>
              Choose where this draft publishes, and which platforms write their own version. The
              main version is the text you write first; other platforms can use it.
              {exclusive ? ' An article or a reply publishes to one X account only.' : ''}
            </DialogDescription>
          </DialogHeader>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Connect an account to publish. You can write your draft now.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {accounts.map((account) => {
                const on = enabled.includes(account.id)
                const version = versionFor(versions, account.channel)
                const supported = CAPABILITIES[account.channel].kinds.includes(kind)
                return (
                  <li className="rounded-lg border border-border p-3" key={account.id}>
                    <div className="flex items-center gap-3">
                      <ChannelIcon channel={account.channel} className="size-4 text-foreground" />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="block truncate text-foreground">
                          {account.displayName ??
                            account.handle ??
                            CHANNEL_META[account.channel].label}
                        </span>
                        <span className="block text-label text-muted-foreground">
                          {account.handle ? `@${account.handle} · ` : ''}
                          {healthLabel(account.health)}
                          {account.channel === 'x'
                            ? account.xCaptionLimit === 25_000
                              ? ' · longer posts verified'
                              : ' · standard post limit'
                            : ''}
                        </span>
                      </span>
                      {account.channel === primary ? (
                        <span className="text-label text-muted-foreground">Main</span>
                      ) : null}
                      {on && onPreview ? (
                        <Button
                          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                          onClick={() => onPreview(account.channel)}
                          size={null}
                          type="button"
                          variant="custom"
                        >
                          Preview
                        </Button>
                      ) : null}
                      <Switch
                        aria-label={`Publish to ${CHANNEL_META[account.channel].label}`}
                        checked={on}
                        disabled={!supported || (exclusive && !on && enabled.length > 0)}
                        onCheckedChange={(checked) => toggle(account, checked === true)}
                      />
                    </div>
                    {!supported ? (
                      <p className="mt-1 text-label text-muted-foreground">
                        {CHANNEL_META[account.channel].label} does not take this kind of draft.
                      </p>
                    ) : null}
                    {account.health !== 'connected' ? (
                      <a
                        className="mt-1 block text-label text-amber-700 dark:text-amber-300 underline"
                        href="/settings/channels"
                      >
                        Reconnect in workspace settings
                      </a>
                    ) : null}
                    {on && account.channel !== primary ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Text:</span>
                        <Button
                          aria-pressed={version.mode === 'synced'}
                          className={cn(
                            'rounded-md border px-2 py-1',
                            version.mode === 'synced'
                              ? 'border-sky-400/50 text-sky-700 dark:text-sky-200'
                              : 'border-border text-muted-foreground'
                          )}
                          onClick={() => version.mode === 'manual' && setResync(account.channel)}
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
                                account.channel,
                                value,
                                draftVersion,
                                Boolean(CAPABILITIES[account.channel].thread)
                              ),
                            })
                          }
                          size={null}
                          type="button"
                          variant="custom"
                        >
                          Its own text
                        </Button>
                        {versionFor(versions, account.channel).mode === 'synced' &&
                        CAPABILITIES[account.channel].kinds.includes(kind) ? (
                          <Button
                            className="ml-auto text-muted-foreground hover:text-foreground"
                            onClick={() => onChange({ primaryPlatform: account.channel })}
                            size={null}
                            type="button"
                            variant="custom"
                          >
                            Make primary
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {onConnect ? (
            <div className="flex flex-wrap gap-2" aria-label="Connect an account">
              {CONNECT_PROVIDERS.filter((provider) => !accounts.some((account) => account.platform === provider.platform && account.health === 'connected')).map((provider) => (
                <Button key={provider.provider} size="sm" variant="outline" onClick={() => void onConnect(provider.provider)}>
                  Connect {provider.label}
                </Button>
              ))}
            </div>
          ) : accounts.length === 0 ? <p className="text-sm text-muted-foreground">Ask an admin or publisher to connect an account.</p> : null}
          <DialogFooter className="items-center sm:justify-between">
            {defaultsHref ? (
              <SidebarLink
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                href={defaultsHref}
              >
                Change default platforms
              </SidebarLink>
            ) : (
              <span />
            )}
            <Button onClick={onClose} type="button">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog onOpenChange={(open) => !open && setResync(null)} open={resync !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Sync {resync ? CHANNEL_META[resync].label : ''} with {CHANNEL_META[primary].label}{' '}
              again?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its own text is replaced by {CHANNEL_META[primary].label}’s from now on. A backup
              keeps the current text.
              {orphaned.length > 0
                ? ` ${orphaned.length} comment thread${orphaned.length === 1 ? '' : 's'} on its text will lose their anchor and show as resolved-orphaned.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep its own text</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (resync) onChange({ versions: resyncVersion(versions, resync).versions })
                setResync(null)
              }}
            >
              Replace with {CHANNEL_META[primary].label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * A synced version: what it will post, read-only, and the way to give it its
 * own text. A manual version whose primary moved on says so and offers a
 * comparison.
 */
export function SyncedVersion({
  channel,
  onFork,
  primary,
  value,
}: {
  channel: DraftChannel
  onFork?: () => void
  primary: DraftChannel
  value: PlateBody
}) {
  const posts = serializeDraft(value, channel).posts
  return (
    <div className="mx-auto max-w-2xl px-6 py-6" data-testid={`synced-version-${channel}`}>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-foreground/[0.02] px-3 py-2 text-xs text-muted-foreground">
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
      {(channel === 'bluesky' || channel === 'instagram') && (
        <p className="mb-3 text-xs text-muted-foreground">{CHANNEL_META[channel].label}: polls unavailable</p>
      )}
      {posts.length === 0 ? <p className="text-sm text-muted-foreground">Nothing written yet.</p> : null}
      {posts.map((post, index) => (
        <article
          className="mb-3 whitespace-pre-wrap rounded-lg border border-border p-3 text-body leading-relaxed text-foreground"
          key={index}
        >
          {post.caption}
        </article>
      ))}
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

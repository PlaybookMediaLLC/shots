'use client'

import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { WarningIcon } from '@phosphor-icons/react/dist/ssr/Warning'
import { useWriteRouter } from '@/components/write/write-context'

import Link from 'next/link'
import type { SocialAccountHealth } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { DEFAULT_BRAND_NAME } from '@/components/settings/social-sets/api'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { cn } from '@/lib/utils'
import { rememberSet, useWrite, type WriteSet } from './write-context'

/** An account's health in words, for a hint or a warning. */
export function healthLabel(health: SocialAccountHealth): string {
  switch (health) {
    case 'connected':
      return 'Connected'
    case 'unverified':
      return 'Credentials unverified: reconnect it'
    case 'reconnect_required':
      return 'Needs reconnecting'
    case 'expired':
      return 'Expired: reconnect it'
    case 'revoked':
      return 'Access revoked: reconnect it'
    case 'permission_required':
      return 'Needs a permission: reconnect it'
    case 'removed':
      return 'Removed'
  }
}

/** A set's colour dot. */
export function SetDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  )
}

/**
 * The brand the library and composer write as (RFC 024). Sets with the
 * same name stay apart: each shows its accounts' handles, and the id is what
 * is used. Sets are created and edited in workspace settings.
 */
export function SocialSetSwitcher() {
  const router = useWriteRouter()
  const { activeId, canManageSets, data, setQuery } = useWrite()
  const active = data.activeSet
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Publishing brand: ${active?.name ?? 'none'}`}
          className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm text-foreground hover:bg-foreground/[0.05]"
          data-testid="social-set-switcher"
          size={null}
          type="button"
          variant="custom"
        >
          {active ? <SetDot color={active.color} /> : null}
          <span className="min-w-0 flex-1 truncate font-medium">
            {active?.name ?? 'No publishing brand'}
          </span>
          {active ? <SetAccounts set={active} /> : null}
          {active?.needsAttention ? (
            <span
              className="text-xs text-amber-700 dark:text-amber-300"
              title="An account needs attention"
            >
              <WarningIcon aria-label="An account needs attention" className="size-3.5" />
            </span>
          ) : null}
          <CaretDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Publishing brands</DropdownMenuLabel>
        {data.sets.map((set) => (
          <DropdownMenuItem
            className="flex items-center gap-2"
            key={set.id}
            onSelect={() => {
              rememberSet(set.id)
              // A draft open from another set is that set's: leave it for the library.
              if (
                activeId &&
                activeId !== 'plan' &&
                activeId !== 'settings' &&
                activeId !== 'analyze' &&
                set.id !== data.activeSet?.id
              )
                router.push(`/publish?set=${encodeURIComponent(set.id)}`)
              else setQuery({ account: undefined, q: undefined, set: set.id, tag: undefined })
            }}
          >
            <SetDot color={set.color} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{set.name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {set.accounts.length === 0
                  ? 'No accounts yet'
                  : set.accounts
                      .map((account) => (account.handle ? `@${account.handle}` : account.platform))
                      .join(' · ')}
              </span>
            </span>
            {set.visibility === 'PRIVATE' ? (
              <span className="text-[10px] text-muted-foreground" title="Only its owner sees it">
                private
              </span>
            ) : null}
            {set.id === active?.id ? <span aria-label="Current set">✓</span> : null}
          </DropdownMenuItem>
        ))}
        {canManageSets ? (
          <>
            <DropdownMenuSeparator />
            {active ? (
              <DropdownMenuItem asChild>
                <Link href={socialSetHref(active.id)}>
                  {active.name === DEFAULT_BRAND_NAME ? 'Name this brand…' : `Edit ${active.name}…`}
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link href="/settings/publishing-brands">New publishing brand…</Link>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A set's account icons, with a warning on any that needs attention. */
export function SetAccounts({ set }: { set: WriteSet }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {set.accounts.map((account) => (
        <span
          className={cn(account.health !== 'connected' && 'text-amber-700 dark:text-amber-300')}
          key={account.id}
          title={`${account.displayName ?? account.handle ?? account.platform}${
            account.health === 'connected' ? '' : `: ${healthLabel(account.health).toLowerCase()}`
          }`}
        >
          <ChannelIcon channel={account.channel} />
        </span>
      ))}
    </span>
  )
}

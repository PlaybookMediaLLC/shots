import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import type { DestinationAccount } from '@/lib/write/composing-session'
import { cn } from '@/lib/utils'

/** An account a post goes to, as people recognise it. */
export type Destination = DestinationAccount

/** "@handle", else the account's name, else its platform. */
export function destinationName(account: Destination): string {
  if (account.handle) return account.handle.startsWith('@') ? account.handle : `@${account.handle}`
  return account.displayName ?? CHANNEL_META[account.channel].label
}

/**
 * Where a post goes, beside the writing actions: "X · @founder" for one
 * account, each account's chip for several. It names what the draft publishes
 * to, so a destination is never only implied by the tab being edited.
 */
export function DestinationSummary({
  accounts,
  className,
  empty = 'No account chosen',
}: {
  accounts: readonly Destination[]
  className?: string
  /** What to say when there is no account to name. */
  empty?: string
}) {
  return (
    <span
      className={cn('inline-flex min-w-0 flex-wrap items-center gap-1.5 text-label', className)}
      data-testid="destination-summary"
    >
      {accounts.length === 0 ? (
        <span className="text-muted-foreground">{empty}</span>
      ) : (
        accounts.map((account) => (
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-foreground"
            key={account.id}
          >
            <ChannelIcon channel={account.channel} />
            <span className="sr-only">{CHANNEL_META[account.channel].label}</span>
            {accounts.length === 1 ? (
              <span aria-hidden className="text-muted-foreground">
                {CHANNEL_META[account.channel].label} ·
              </span>
            ) : null}
            <span className="truncate">{destinationName(account)}</span>
          </span>
        ))
      )}
    </span>
  )
}

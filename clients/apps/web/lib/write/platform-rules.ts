import { CAPABILITIES } from '@/lib/write/capabilities'
import type { DraftChannel, DraftKind } from '@/lib/write/document'
import { DESTINATION_MEDIA, LABELS } from '@/lib/write/media-rules'

/** Why a platform's switch can't change for this draft, or null when it can. */
export function platformRefusal(
  channel: DraftChannel,
  kind: DraftKind,
  on: boolean,
  enabledCount: number
): string | null {
  if (!CAPABILITIES[channel].kinds.includes(kind))
    return `${LABELS[channel]} does not take this kind of draft.`
  if ((kind === 'article' || kind === 'reply') && !on && enabledCount > 0)
    return 'An article or a reply publishes to one X account only.'
  return null
}

/** One connected account, with what its version of the draft holds. */
export type MediaSwitchAccount = {
  channel: DraftChannel
  hasMedia: boolean
  hasText: boolean
  id: string
}

/**
 * Which platforms to turn off because the post has words but no media they
 * require, and which to turn back on now that it has media. A platform the
 * person chose to keep stays as it is. Turning off every destination helps
 * nobody, so then none goes and the fix list explains what is missing.
 */
export function mediaSwitches(
  accounts: MediaSwitchAccount[],
  enabled: string[],
  switchedOff: ReadonlySet<string>,
  kept: ReadonlySet<string>
): { off: string[]; on: string[] } {
  const off = accounts
    .filter(
      (account) =>
        enabled.includes(account.id) &&
        !kept.has(account.id) &&
        DESTINATION_MEDIA[account.channel].requiresMedia &&
        account.hasText &&
        !account.hasMedia
    )
    .map((account) => account.id)
  return {
    off: off.length < enabled.length ? off : [],
    on: accounts
      .filter(
        (account) =>
          switchedOff.has(account.id) && !enabled.includes(account.id) && account.hasMedia
      )
      .map((account) => account.id),
  }
}

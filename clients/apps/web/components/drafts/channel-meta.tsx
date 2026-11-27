import { FacebookLogoIcon } from '@phosphor-icons/react/dist/ssr/FacebookLogo'
import { GoogleLogoIcon } from '@phosphor-icons/react/dist/ssr/GoogleLogo'
import { PinterestLogoIcon } from '@phosphor-icons/react/dist/ssr/PinterestLogo'
import { TiktokLogoIcon } from '@phosphor-icons/react/dist/ssr/TiktokLogo'
import { YoutubeLogoIcon } from '@phosphor-icons/react/dist/ssr/YoutubeLogo'
import { InstagramLogoIcon as InstagramIcon } from '@phosphor-icons/react/dist/ssr/InstagramLogo'
import { LinkedinLogoIcon as Linkedin01Icon } from '@phosphor-icons/react/dist/ssr/LinkedinLogo'
import { MastodonLogoIcon as MastodonIcon } from '@phosphor-icons/react/dist/ssr/MastodonLogo'
import { XLogoIcon as NewTwitterIcon } from '@phosphor-icons/react/dist/ssr/XLogo'
import { ThreadsLogoIcon as ThreadsIcon } from '@phosphor-icons/react/dist/ssr/ThreadsLogo'
import type { ComponentType } from 'react'
import type { DraftChannel } from '@/lib/content-drafts/serialize'

function BlueskyIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M5.202 2.857C7.954 4.922 10.913 9.11 12 11.358c1.087-2.247 4.046-6.436 6.798-8.501C20.783 1.366 24 .213 24 3.883c0 .732-.42 6.156-.667 7.037-.856 3.061-3.978 3.842-6.755 3.37 4.854.826 6.089 3.562 3.422 6.299-5.065 5.196-7.28-1.304-7.847-2.97-.104-.305-.152-.448-.153-.327 0-.121-.05.022-.153.327-.568 1.666-2.782 8.166-7.847 2.97-2.667-2.737-1.432-5.473 3.422-6.3-2.777.473-5.899-.308-6.755-3.369C.42 10.04 0 4.615 0 3.883c0-3.67 3.217-2.517 5.202-1.026" />
    </svg>
  )
}

/** How each channel is named and drawn in the composer. */
export const CHANNEL_META: Record<
  DraftChannel,
  { icon: ComponentType<{ className?: string }>; label: string }
> = {
  bluesky: { icon: BlueskyIcon, label: 'Bluesky' },
  instagram: { icon: InstagramIcon, label: 'Instagram' },
  linkedin: { icon: Linkedin01Icon, label: 'LinkedIn' },
  mastodon: { icon: MastodonIcon, label: 'Mastodon' },
  threads: { icon: ThreadsIcon, label: 'Threads' },
  tiktok: { icon: TiktokLogoIcon, label: 'TikTok' },
  youtube: { icon: YoutubeLogoIcon, label: 'YouTube' },
  x: { icon: NewTwitterIcon, label: 'X' },
  facebook: { icon: FacebookLogoIcon, label: 'Facebook' },
  pinterest: { icon: PinterestLogoIcon, label: 'Pinterest' },
  gmb: { icon: GoogleLogoIcon, label: 'Google Business' },
}

/** A channel's icon at the composer's small size. */
export function ChannelIcon({ channel, className }: { channel: DraftChannel; className?: string }) {
  const Icon = CHANNEL_META[channel].icon
  return <Icon aria-hidden className={className ?? 'size-3.5'} />
}

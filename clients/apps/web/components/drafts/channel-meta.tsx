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
import { SiBluesky as BlueskyIcon } from 'react-icons/si'
import type { ComponentType } from 'react'
import type { DraftChannel } from '@/lib/content-drafts/serialize'

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

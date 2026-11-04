'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/ssr/Copy'
import { ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { ImageBrokenIcon as ImageOff } from '@phosphor-icons/react/dist/ssr/ImageBroken'
import { useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import type { LinkPreview } from '@/lib/api/contracts/link-preview'
import { cn } from '@/lib/utils'
import { copyText } from './client'
import { serpFit } from './serp'

/** The bare hostname of a URL, without `www.`. */
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The platforms a link is previewed on, in tab order. */
export const previewPlatformSchema = z.enum([
  'telegram',
  'discord',
  'slack',
  'x',
  'facebook',
  'linkedin',
  'whatsapp',
  'google',
  'imessage',
  'bluesky',
  'threads',
  'mastodon',
  'reddit',
])

/** One of {@link previewPlatformSchema}. */
export type PreviewPlatform = z.infer<typeof previewPlatformSchema>

/**
 * How a platform lays a link out: an image card, a chat embed with an accent
 * bar and the image below, a side thumbnail, or a search result.
 */
export const previewLayoutSchema = z.enum(['card', 'embed', 'thumb', 'search'])

const { card: CARD, embed: EMBED, search: SEARCH, thumb: THUMB } = previewLayoutSchema.enum
const P = previewPlatformSchema.enum

/** Whether cards show in the platform's dark or light theme. */
export const previewThemeSchema = z.enum(['dark', 'light'])

/** Whether cards show at a phone's width or a desktop's. */
export const previewDeviceSchema = z.enum(['desktop', 'mobile'])

/** One of {@link previewThemeSchema}. */
export type PreviewTheme = z.infer<typeof previewThemeSchema>

/** One of {@link previewDeviceSchema}. */
export type PreviewDevice = z.infer<typeof previewDeviceSchema>

const LIGHT = previewThemeSchema.enum.light
const MOBILE = previewDeviceSchema.enum.mobile

/** The colors a platform draws a card with in one theme. */
type Look = {
  accent?: string
  frame: string
  media: string
  site: string
  title: string
  description: string
  /** The Google URL line under the site name. */
  breadcrumb?: string
}

/** How one platform draws a link: its layout, what it shows, and its colors. */
export type Platform = {
  id: PreviewPlatform
  name: string
  layout: z.infer<typeof previewLayoutSchema>
  /** The site line goes under the title instead of above it. */
  labelBelow?: boolean
  hideDescription?: boolean
  /** Read the HTML title and description first, as search engines do. */
  preferHtml?: boolean
  /** The embed's bar color; `themeAccent` uses the page's theme-color when it has one. */
  accent?: string
  themeAccent?: boolean
  /** Show the full URL as the site line. */
  showUrl?: boolean
  /** The light theme's colors, over the dark ones. */
  light: Partial<Look>
} & Look

/** Every platform's look, in tab order. */
export const PLATFORMS: Platform[] = [
  {
    id: P.telegram,
    light: {
      accent: '#3390ec',
      frame: 'rounded-lg bg-white',
      media: 'bg-[#f1f1f1]',
      site: 'text-[13px] font-semibold text-[#3390ec]',
      title: 'line-clamp-2 text-[14px] font-semibold text-black',
      description: 'line-clamp-3 text-[14px] text-[#000000d9]',
    },
    name: 'Telegram',
    layout: EMBED,
    accent: '#6ab3f3',
    frame: 'rounded-lg bg-[#182533]',
    media: 'bg-[#0e1621]',
    site: 'text-[13px] font-semibold text-[#6ab3f3]',
    title: 'line-clamp-2 text-[14px] font-semibold text-white',
    description: 'line-clamp-3 text-[14px] text-[#e4ecf2]',
  },
  {
    id: P.discord,
    light: {
      accent: '#e3e5e8',
      frame: 'rounded bg-[#f2f3f5]',
      media: 'bg-[#e3e5e8]',
      site: 'text-xs text-[#4e5058]',
      title: 'line-clamp-2 text-base font-semibold text-[#006ce7] hover:underline',
      description: 'line-clamp-3 text-sm text-[#313338]',
    },
    name: 'Discord',
    layout: EMBED,
    accent: '#1e1f22',
    themeAccent: true,
    frame: 'rounded bg-[#2b2d31]',
    media: 'bg-[#1e1f22]',
    site: 'text-xs text-[#dbdee1]',
    title: 'line-clamp-2 text-base font-semibold text-[#00a8fc] hover:underline',
    description: 'line-clamp-3 text-sm text-[#dbdee1]',
  },
  {
    id: P.slack,
    light: {
      accent: '#dddddd',
      frame: 'rounded bg-white',
      media: 'bg-[#f8f8f8]',
      site: 'text-ui-lg font-bold text-[#1d1c1d]',
      title: 'line-clamp-2 text-[15px] font-bold text-[#1264a3]',
      description: 'line-clamp-3 text-[15px] text-[#1d1c1d]',
    },
    name: 'Slack',
    layout: EMBED,
    accent: '#4a4b4f',
    frame: 'rounded bg-[#1a1d21]',
    media: 'bg-[#222529]',
    site: 'text-ui-lg font-bold text-[#d1d2d3]',
    title: 'line-clamp-2 text-[15px] font-bold text-[#1d9bd1]',
    description: 'line-clamp-3 text-[15px] text-[#d1d2d3]',
  },
  {
    id: P.x,
    light: {
      frame: 'rounded-[12px] border border-[#cfd9de] bg-white',
      media: 'bg-[#f7f9f9]',
      site: 'text-[13px] text-[#536471]',
      title: 'line-clamp-2 text-[15px] font-medium leading-tight text-[#0f1419]',
      description: 'line-clamp-2 text-[15px] leading-normal text-[#536471]',
    },
    name: 'X',
    layout: CARD,
    showUrl: true,
    frame: 'rounded-[12px] border border-[#2f3336] bg-black',
    media: 'bg-[#16181c]',
    site: 'text-[13px] text-[#71767b]',
    title: 'line-clamp-2 text-[15px] font-medium leading-tight text-[#e7e9ea]',
    description: 'line-clamp-2 text-[15px] leading-normal text-[#71767b]',
  },
  {
    id: P.facebook,
    light: {
      frame: 'rounded border border-[#dadde1] bg-[#f0f2f5]',
      media: 'bg-[#e4e6eb]',
      site: 'text-xs uppercase text-[#606770]',
      title: 'line-clamp-1 text-[15px] font-semibold text-[#1d2129]',
      description: 'line-clamp-1 text-[13px] text-[#606770]',
    },
    name: 'Facebook',
    layout: CARD,
    frame: 'rounded border border-[#3e4042] bg-[#242526]',
    media: 'bg-[#3a3b3c]',
    site: 'text-xs uppercase text-[#b0b3b8]',
    title: 'line-clamp-1 text-[15px] font-semibold text-[#e4e6eb]',
    description: 'line-clamp-1 text-[13px] text-[#b0b3b8]',
  },
  {
    id: P.linkedin,
    light: {
      frame: 'rounded-[2px] border border-[#e0dfdc] bg-white',
      media: 'bg-[#f3f2ef]',
      site: 'text-[12px] text-[#00000099]',
      title: 'line-clamp-2 text-[14px] font-semibold leading-tight text-[#000000e6]',
    },
    name: 'LinkedIn',
    layout: CARD,
    labelBelow: true,
    hideDescription: true,
    frame: 'rounded-[2px] border border-[#38434f] bg-[#1b1f23]',
    media: 'bg-[#38434f]',
    site: 'text-[12px] text-[#ffffff99]',
    title: 'line-clamp-2 text-[14px] font-semibold leading-tight text-white',
    description: '',
  },
  {
    id: P.whatsapp,
    light: {
      frame: 'rounded-lg bg-[#f0f2f5]',
      media: 'bg-[#e9edef]',
      site: 'text-[12.5px] text-[#667781]',
      title: 'line-clamp-2 text-[14px] font-medium text-[#111b21]',
      description: 'line-clamp-2 text-[13px] text-[#667781]',
    },
    name: 'WhatsApp',
    layout: CARD,
    labelBelow: true,
    frame: 'rounded-lg bg-[#1f2c34]',
    media: 'bg-[#2a3942]',
    site: 'text-[12.5px] text-[#8696a0]',
    title: 'line-clamp-2 text-[14px] font-medium text-[#e9edef]',
    description: 'line-clamp-2 text-[13px] text-[#8696a0]',
  },
  {
    id: P.google,
    light: {
      breadcrumb: 'text-[#4d5156]',
      frame: 'rounded-lg bg-white',
      media: 'bg-[#f1f3f4]',
      site: 'text-sm text-[#202124]',
      title: 'line-clamp-1 text-xl text-[#1a0dab] hover:underline',
      description: 'line-clamp-2 text-sm text-[#4d5156]',
    },
    name: 'Google',
    layout: SEARCH,
    preferHtml: true,
    frame: 'rounded-lg bg-[#1f1f1f]',
    media: 'bg-[#303134]',
    site: 'text-sm text-[#dadce0]',
    breadcrumb: 'text-[#bdc1c6]',
    title: 'line-clamp-1 text-xl text-[#99c3ff] hover:underline',
    description: 'line-clamp-2 text-sm text-[#bdc1c6]',
  },
  {
    id: P.imessage,
    light: {
      frame: 'rounded-2xl bg-[#e9e9eb]',
      media: 'bg-[#d1d1d6]',
      site: 'text-[12px] text-[#8e8e93]',
      title: 'line-clamp-2 text-[13px] font-semibold leading-snug text-black',
    },
    name: 'iMessage',
    layout: CARD,
    labelBelow: true,
    hideDescription: true,
    frame: 'rounded-2xl bg-[#262628]',
    media: 'bg-[#3a3a3c]',
    site: 'text-[12px] text-[#98989d]',
    title: 'line-clamp-2 text-[13px] font-semibold leading-snug text-white',
    description: '',
  },
  {
    id: P.bluesky,
    light: {
      frame: 'rounded-xl border border-[#d4dbe2] bg-white',
      media: 'bg-[#f1f3f5]',
      site: 'border-t border-[#d4dbe2] pt-2 text-xs text-[#42576c]',
      title: 'line-clamp-2 text-[15px] font-semibold text-[#0b0f14]',
      description: 'line-clamp-2 text-[13px] text-[#42576c]',
    },
    name: 'Bluesky',
    layout: CARD,
    labelBelow: true,
    frame: 'rounded-xl border border-[#2e4052] bg-[#161e27]',
    media: 'bg-[#1e2936]',
    site: 'border-t border-[#2e4052] pt-2 text-xs text-[#aebbc9]',
    title: 'line-clamp-2 text-[15px] font-semibold text-[#f1f3f5]',
    description: 'line-clamp-2 text-[13px] text-[#aebbc9]',
  },
  {
    id: P.threads,
    light: {
      frame: 'rounded-xl border border-[#e5e5e5] bg-white',
      media: 'bg-[#f5f5f5]',
      site: 'text-[13px] text-[#999999]',
      title: 'line-clamp-2 text-[15px] font-semibold text-black',
    },
    name: 'Threads',
    layout: CARD,
    hideDescription: true,
    frame: 'rounded-xl border border-[#333638] bg-[#181818]',
    media: 'bg-[#262626]',
    site: 'text-[13px] text-[#777777]',
    title: 'line-clamp-2 text-[15px] font-semibold text-[#f3f5f7]',
    description: '',
  },
  {
    id: P.mastodon,
    light: {
      frame: 'rounded-lg border border-[#c0cdd9] bg-white',
      media: 'bg-[#eff3f5]',
      site: 'text-[13px] text-[#606984]',
      title: 'line-clamp-2 text-[15px] font-bold text-black',
      description: 'line-clamp-2 text-[13px] text-[#606984]',
    },
    name: 'Mastodon',
    layout: CARD,
    frame: 'rounded-lg border border-[#393f4f] bg-[#282c37]',
    media: 'bg-[#313543]',
    site: 'text-[13px] text-[#9baec8]',
    title: 'line-clamp-2 text-[15px] font-bold text-white',
    description: 'line-clamp-2 text-[13px] text-[#9baec8]',
  },
  {
    id: P.reddit,
    light: {
      frame: 'rounded-2xl border border-[#edeff1] bg-white',
      media: 'bg-[#f6f7f8]',
      site: 'text-xs text-[#576f76]',
      title: 'line-clamp-3 text-base font-semibold text-[#0f1a1c]',
    },
    name: 'Reddit',
    layout: THUMB,
    labelBelow: true,
    hideDescription: true,
    frame: 'rounded-2xl border border-[#2a3c42] bg-[#0b1416]',
    media: 'bg-[#1a282d]',
    site: 'text-xs text-[#82959b]',
    title: 'line-clamp-3 text-base font-semibold text-[#d7dadc]',
    description: '',
  },
]

/** What a platform shows, with the fallbacks it uses when a tag is missing. */
function cardText(platform: Platform, preview: LinkPreview, url: string) {
  const html = platform.preferHtml
  return {
    description: html
      ? preview.description || preview.ogDescription
      : preview.ogDescription || preview.description || preview.twitterDescription,
    image: preview.ogImage || preview.twitterImage,
    siteName: preview.ogSiteName || hostname(url),
    title: html
      ? preview.title || preview.ogTitle || url
      : preview.ogTitle || preview.title || preview.twitterTitle || url,
  }
}

function PreviewImage({ alt, src }: { alt: string; src?: string }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <ImageOff className="size-6 text-white/30" aria-label="No image" />
  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      className={cn(
        'size-full object-cover transition-opacity duration-300',
        loaded ? 'opacity-100' : 'opacity-0'
      )}
    />
  )
}

function Favicon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return null
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn('size-4 shrink-0 rounded-sm object-contain', className)}
    />
  )
}

/** The Google-style breadcrumb: host, then path segments. */
function breadcrumb(url: string): string {
  try {
    const { hostname: host, pathname, protocol } = new URL(url)
    return [`${protocol}//${host}`, ...pathname.split('/').filter(Boolean)].join(' › ')
  } catch {
    return url
  }
}

/** A link card drawn the way `platform` unfurls it, under the post text when there is one. */
export function PlatformPreview({
  device,
  platform,
  post,
  theme,
  ...card
}: {
  device?: PreviewDevice
  platform: Platform
  /** The text posted with the link. Search results have none. */
  post?: string
  preview: LinkPreview
  theme?: PreviewTheme
  url: string
}) {
  const look = theme === LIGHT ? { ...platform, ...platform.light } : platform
  const width =
    device === MOBILE
      ? 'max-w-[340px]'
      : platform.layout === SEARCH
        ? 'max-w-[600px]'
        : 'max-w-[516px]'
  return (
    <div className={cn('w-full space-y-2', width)}>
      {post?.trim() && platform.layout !== SEARCH && (
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-[15px] leading-snug',
            theme === LIGHT ? 'text-neutral-900' : 'text-foreground'
          )}
        >
          {post}
        </p>
      )}
      <Card device={device} platform={look} {...card} />
    </div>
  )
}

function Card({
  device,
  platform,
  preview,
  url,
}: {
  device?: PreviewDevice
  platform: Platform
  preview: LinkPreview
  url: string
}) {
  const text = cardText(platform, preview, url)
  const smallXCard =
    platform.id === previewPlatformSchema.enum.x && preview.twitterCard === 'summary'
  const layout = smallXCard ? THUMB : platform.layout
  const label = (
    <p className={cn('truncate', platform.site)}>{platform.showUrl ? url : hostname(url)}</p>
  )
  const body = (
    <>
      {!platform.labelBelow && label}
      <p className={platform.title}>{text.title}</p>
      {!platform.hideDescription && text.description && (
        <p className={platform.description}>{text.description}</p>
      )}
      {platform.labelBelow && label}
    </>
  )

  if (layout === SEARCH) {
    return (
      <div className={cn('space-y-1.5 p-4', platform.frame)}>
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'grid size-7 shrink-0 place-items-center overflow-hidden rounded-full',
              platform.media
            )}
          >
            <Favicon src={preview.favicon} className="size-[18px]" />
          </span>
          <div className="min-w-0 leading-tight">
            <p className={cn('truncate', platform.site)}>{text.siteName}</p>
            <p className={cn('truncate text-xs', platform.breadcrumb)}>{breadcrumb(url)}</p>
          </div>
        </div>
        <p className={platform.title} title={text.title}>
          {device === MOBILE ? text.title : serpFit(text.title, 'title').shown}
        </p>
        {text.description && (
          <p className={platform.description}>
            {device === MOBILE ? text.description : serpFit(text.description, 'description').shown}
          </p>
        )}
      </div>
    )
  }

  if (layout === EMBED) {
    const accent = (platform.themeAccent && preview.themeColor) || platform.accent
    return (
      <div className={cn('border-l-4 p-3', platform.frame)} style={{ borderLeftColor: accent }}>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Favicon src={preview.favicon} />
            <p className={cn('truncate', platform.site)}>{text.siteName}</p>
          </div>
          <p className={platform.title}>{text.title}</p>
          {text.description && <p className={platform.description}>{text.description}</p>}
        </div>
        {text.image && (
          <div
            className={cn(
              'mt-3 flex aspect-[1.91/1] max-w-sm items-center justify-center overflow-hidden rounded-md',
              platform.media
            )}
          >
            <PreviewImage key={text.image} src={text.image} alt={text.title} />
          </div>
        )}
      </div>
    )
  }

  if (layout === THUMB) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 overflow-hidden p-3',
          smallXCard ? 'flex-row' : 'flex-row-reverse',
          platform.frame
        )}
      >
        <div
          className={cn(
            'flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg',
            platform.media
          )}
        >
          <PreviewImage key={text.image} src={text.image} alt={text.title} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">{body}</div>
      </div>
    )
  }

  return (
    <div className={cn('overflow-hidden', platform.frame)}>
      <div
        className={cn(
          'flex aspect-[1.91/1] items-center justify-center overflow-hidden',
          platform.media
        )}
      >
        <PreviewImage key={text.image} src={text.image} alt={text.title} />
      </div>
      <div className="space-y-1 p-3">{body}</div>
    </div>
  )
}

/** Every platform's card at once. */
export function AllPreviews({
  device,
  post,
  preview,
  theme,
  url,
}: {
  device?: PreviewDevice
  post?: string
  preview: LinkPreview
  theme?: PreviewTheme
  url: string
}) {
  return (
    <div className="grid gap-x-6 gap-y-8 md:grid-cols-2">
      {PLATFORMS.map((platform) => (
        <div key={platform.id} className="min-w-0 space-y-2">
          <p
            className={cn(
              'text-xs uppercase tracking-wide',
              theme === LIGHT ? 'text-neutral-500' : 'text-muted-foreground'
            )}
          >
            {platform.name}
          </p>
          <PlatformPreview
            device={device}
            platform={platform}
            post={post}
            preview={preview}
            theme={theme}
            url={url}
          />
        </div>
      ))}
    </div>
  )
}

/** A link to `url` that no platform has cached yet. */
function cacheBusted(url: string): string {
  const busted = new URL(url)
  busted.searchParams.set('v', String(Date.now()).slice(-6))
  return busted.toString()
}

/** Where each platform caches previews, and how to make it read the page again. */
export function CacheRefresh({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const encoded = encodeURIComponent(url)
  const tools = [
    {
      name: 'Facebook',
      how: 'Open the Sharing Debugger and press Scrape Again.',
      href: `https://developers.facebook.com/tools/debug/?q=${encoded}`,
    },
    {
      name: 'LinkedIn',
      how: 'Inspect the URL in Post Inspector to refresh its card.',
      href: `https://www.linkedin.com/post-inspector/inspect/${encoded}`,
    },
    { name: 'Telegram', how: 'Send the link to @WebpageBot to update its preview.' },
    {
      name: 'X, Slack, Discord, WhatsApp, iMessage',
      how: 'They cache cards for hours to days. Share a cache-busting URL to see changes now.',
    },
  ]
  return (
    <section className="space-y-3 rounded-2xl bg-white/[0.015] p-5 ring-1 ring-white/[0.08]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-ui-lg font-medium text-foreground">Changed your tags?</h3>
          <p className="text-xs text-muted-foreground">
            Platforms cache previews. Make each one read the page again.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            if (await copyText(cacheBusted(url))) {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }
          }}
        >
          {copied ? <Check className="text-emerald-500" /> : <Copy />}
          {copied ? 'Copied' : 'Copy cache-busting URL'}
        </Button>
      </div>
      <ul className="divide-y divide-white/[0.07] text-sm">
        {tools.map((tool) => (
          <li key={tool.name} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span>
              <span className="font-medium text-foreground">{tool.name}</span>
              <span className="text-muted-foreground"> · {tool.how}</span>
            </span>
            {tool.href && (
              <a
                href={tool.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-foreground hover:underline"
              >
                Open
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

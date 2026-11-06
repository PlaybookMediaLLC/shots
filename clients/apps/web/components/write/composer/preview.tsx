'use client'

import * as React from 'react'
import { PreviewLinkCard } from './preview-link-card'
import { LinkPreviewCard, NO_LINK_CARDS } from './link-cards'
import {
  Avatar as AccountAvatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { assetContentUrl } from '@/lib/editor/services'
import type { SerializedMedia } from '@/lib/content-drafts/serialize'
import { previewLineLimit, previewScale, xCollapsedText } from '@/lib/write/preview-layout'
import type { DraftChannel, DraftTarget } from '@/lib/write/document'
import type { Publication } from '@/lib/write/publication'
import { cn } from '@/lib/utils'
import type { ComposerAccount } from './platforms'
import { PdfCarousel } from './pdf-carousel'

const DescribeMediaContext = React.createContext<((media: SerializedMedia) => void) | undefined>(
  undefined
)

/** Devices the mobile preview lays out for, at their CSS viewport sizes. */
const DEVICES = [
  { height: 667, label: 'iPhone SE', width: 375 },
  { height: 852, label: 'iPhone 16', width: 393 },
  { height: 874, label: 'iPhone 17 / Pro', width: 402 },
  { height: 912, label: 'iPhone Air', width: 420 },
  { height: 956, label: 'iPhone 17 Pro Max', width: 440 },
  { height: 780, label: 'Samsung Galaxy S25', width: 360 },
  { height: 915, label: 'Google Pixel 10', width: 412 },
] as const

/** One destination's preview: its account and its publication. */
export type PreviewItem = { account: ComposerAccount; publication: Publication }

/**
 * The platform and device a person picked. The composer keeps it: switching
 * between the side panel and the sheet remounts the panel, which reset it.
 */
export type PreviewSelection = {
  /** Null follows the composer's active channel. */
  channel: DraftChannel | null
  device: 'desktop' | (typeof DEVICES)[number]['label']
}

/**
 * The realistic preview (RFC 025): each destination laid out as its
 * platform shows it, from the same publication the schedule sends, on a
 * desktop column or a chosen phone. It shows no engagement numbers: nothing
 * here is published, and the banner says so. It never publishes.
 */
export function PreviewPanel({
  items,
  target,
  onDescribe,
  onSelect,
  initialChannel,
  selection,
}: {
  initialChannel?: DraftChannel
  onDescribe?: (media: SerializedMedia) => void
  onSelect: (selection: PreviewSelection) => void
  items: PreviewItem[]
  selection: PreviewSelection
  target: DraftTarget | null
}) {
  const channel = selection.channel ?? initialChannel ?? items[0]?.account.channel ?? null
  const { device } = selection
  const item = items.find((entry) => entry.account.channel === channel) ?? items[0]
  const size = DEVICES.find((entry) => entry.label === device)
  if (!item) {
    return <p className="p-4 text-sm text-muted-foreground">Turn on a platform to preview it.</p>
  }
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="preview-panel">
      <p className="rounded-md border border-dashed border-input px-2 py-1 text-center text-[11px] text-muted-foreground">
        Preview — not published
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((entry) => (
          <Button
            aria-pressed={entry.account.channel === item.account.channel}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
              entry.account.channel === item.account.channel
                ? 'border-foreground/40 text-foreground'
                : 'border-border text-muted-foreground'
            )}
            key={entry.account.id}
            onClick={() => onSelect({ ...selection, channel: entry.account.channel })}
            size={null}
            type="button"
            variant="custom"
          >
            <ChannelIcon channel={entry.account.channel} />
            {CHANNEL_META[entry.account.channel].label}
          </Button>
        ))}
        <Select
          onValueChange={(value) =>
            onSelect({ ...selection, device: value as PreviewSelection['device'] })
          }
          value={device}
        >
          <SelectTrigger aria-label="Preview device" className="ml-auto h-7 w-auto text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desktop">Desktop</SelectItem>
            {DEVICES.map((entry) => (
              <SelectItem key={entry.label} value={entry.label}>
                {entry.label} · {entry.width}×{entry.height}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DescribeMediaContext.Provider value={onDescribe}>
        <ScaledPreview width={size?.width ?? 600} height={size?.height}>
          <div data-testid={`preview-${item.account.channel}`} key={item.account.id}>
            {item.publication.target.options?.articleTitle ? (
              <ArticlePreview item={item} />
            ) : item.account.channel === 'linkedin' ? (
              <LinkedInPost item={item} target={target} />
            ) : item.account.channel === 'tiktok' ? (
              <TikTokPost item={item} />
            ) : (
              <ThreadPreview item={item} target={target} />
            )}
          </div>
        </ScaledPreview>
      </DescribeMediaContext.Provider>
      <p className="text-[11px] text-muted-foreground">
        Cutoffs vary by app and device.
      </p>
      {item.publication.problems.length > 0 ? (
        <ul className="grid gap-0.5" role="alert">
          {item.publication.problems.map((problem) => (
            <li className="text-xs text-red-700 dark:text-red-300" key={problem}>
              {problem}
            </li>
          ))}
        </ul>
      ) : null}
      {item.publication.serialized.degradations.map((degradation) => (
        <p className="text-xs text-amber-700 dark:text-amber-300" key={degradation.kind}>
          {degradation.message}
        </p>
      ))}
    </div>
  )
}

/** An account's avatar, or a face of its own when it has none or it fails to load. */
function Avatar({ account, size = 'size-10' }: { account: ComposerAccount; size?: string }) {
  return (
    <AccountAvatar aria-hidden className={cn(size, 'bg-foreground/5')}>
      {account.avatarUrl ? (
        <AvatarImage alt="" className="object-cover" src={account.avatarUrl} />
      ) : null}
      <AvatarFallback name={account.displayName ?? account.handle ?? '?'} />
    </AccountAvatar>
  )
}

/** Scale an intrinsic feed column inside the available panel, with its own scrolling. */
function ScaledPreview({
  width,
  height,
  children,
}: {
  width: number
  height?: number
  children: React.ReactNode
}) {
  const container = React.useRef<HTMLDivElement>(null)
  const content = React.useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = React.useState({ available: width, height: 0 })
  React.useLayoutEffect(() => {
    const measure = () =>
      setGeometry({
        available: container.current?.clientWidth ?? width,
        height: content.current?.scrollHeight ?? 0,
      })
    const observer = new ResizeObserver(measure)
    if (container.current) observer.observe(container.current)
    if (content.current) observer.observe(content.current)
    measure()
    return () => observer.disconnect()
  }, [width])
  const scale = previewScale(geometry.available, width)
  return (
    <div
      ref={container}
      className="w-full min-w-0 overflow-x-hidden overflow-y-auto rounded-2xl border border-border bg-card"
      style={{ maxHeight: height ? Math.min(height * scale, 720) : '70vh' }}
      data-testid="preview-scroll"
    >
      <div style={{ height: geometry.height * scale, position: 'relative' }}>
        <div
          ref={content}
          style={{ width, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          data-testid="preview-device-content"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

/** Browser line layout provides wrapping; long X posts also use weighted entity counting. */
function Truncated({ channel, text }: { channel: DraftChannel; text: string }) {
  const [open, setOpen] = React.useState(false)
  const [overflow, setOverflow] = React.useState(false)
  const paragraph = React.useRef<HTMLParagraphElement>(null)
  const id = React.useId()
  const lines = previewLineLimit(channel, text)
  const collapsed = channel === 'x' ? xCollapsedText(text) : text
  React.useLayoutEffect(() => {
    const node = paragraph.current
    if (!node || !lines || open) return
    const measure = () =>
      setOverflow(node.scrollHeight > parseFloat(getComputedStyle(node).lineHeight) * lines + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => observer.disconnect()
  }, [text, lines, open])
  const long = collapsed !== text || overflow
  return (
    <div>
      <p
        ref={paragraph}
        id={id}
        className="whitespace-pre-wrap break-words text-[15px] leading-[20px] text-foreground"
        style={
          !open && lines
            ? {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: lines,
                overflow: 'hidden',
                overflowWrap: 'anywhere',
              }
            : { overflowWrap: 'anywhere' }
        }
      >
        <Mentions channel={channel} text={open ? text : collapsed} />
      </p>
      {long ? (
        <Button
          aria-controls={id}
          aria-expanded={open}
          className="text-[15px] text-sky-700 dark:text-sky-400 hover:underline"
          onClick={() => setOpen(!open)}
          size={null}
          type="button"
          variant="custom"
        >
          {open ? 'Show less' : channel === 'linkedin' ? '…more' : 'Show more'}
        </Button>
      ) : null}
    </div>
  )
}

/** Mentions and links drawn in the platform's link colour; LinkedIn annotations by their name. */
function Mentions({ channel, text }: { channel: DraftChannel; text: string }) {
  const parts = text.split(
    /(@\[(?:\\.|[^\]\\])+\]\(urn:li:(?:organization:[0-9]{1,30}|person:[A-Za-z0-9_-]{1,100})\)|@[A-Za-z0-9_]{1,30}|https?:\/\/\S+)/g
  )
  return (
    <>
      {parts.map((part, index) => {
        const annotation = /^@\[((?:\\.|[^\]\\])+)\]/.exec(part)
        if (annotation)
          return (
            <span className="font-medium text-sky-700 dark:text-sky-400" key={index}>
              {annotation[1].replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1')}
            </span>
          )
        if (/^@|^https?:/.test(part))
          return (
            <span
              className={
                channel === 'linkedin'
                  ? 'text-sky-700 dark:text-sky-400'
                  : 'text-sky-700 dark:text-sky-400'
              }
              key={index}
            >
              {part}
            </span>
          )
        return <React.Fragment key={index}>{part}</React.Fragment>
      })}
    </>
  )
}

/** Render every normalized attachment in publication order, including its real description. */
function Media({ media }: { media: SerializedMedia[] }) {
  const onDescribe = React.useContext(DescribeMediaContext)
  if (media.length === 0) return null
  return (
    <div
      className={cn(
        'mt-2 grid gap-0.5 overflow-hidden rounded-2xl border border-border',
        media.length > 1 && 'grid-cols-2'
      )}
    >
      {media.map((item, index) => (
        <figure className="relative m-0 min-w-0" key={`${item.id}-${index}`}>
          {item.kind === 'video' ? (
            <video
              aria-label={item.alt || 'Attached video'}
              className="aspect-video w-full bg-foreground/5 object-contain"
              controls
              preload="metadata"
              src={assetContentUrl(item.assetId)}
            />
          ) : (
            <img
              alt={item.alt}
              className="aspect-video w-full bg-foreground/5 object-cover"
              src={assetContentUrl(item.assetId)}
            />
          )}
          {item.kind !== 'video' && onDescribe ? (
            <Button
              aria-label={item.alt ? 'Edit image description' : 'Add image description'}
              className="bg-black/80 px-2 text-xs"
              size="sm"
              onClick={() => onDescribe(item)}
            >
              {item.alt ? 'Edit ALT' : '+ALT'}
            </Button>
          ) : null}
          {item.photoTags.length ? (
            <p className="text-xs">Tagged: {item.photoTags.map((tag) => tag.label).join(', ')}</p>
          ) : null}
          {item.alt ? (
            <Disclosure className="bg-black/80 px-2 text-xs text-neutral-100">
              <DisclosureTrigger>ALT</DisclosureTrigger>
              <DisclosureContent>
                <p>{item.alt}</p>
              </DisclosureContent>
            </Disclosure>
          ) : null}
          {item.processingStatus !== 'ready' ? (
            <figcaption role="status">
              {item.processingStatus === 'failed' ? 'Processing failed' : 'Processing…'}
            </figcaption>
          ) : null}
        </figure>
      ))}
    </div>
  )
}

/** A poll as the platform draws it before anyone votes: options, no counts. */
function Poll({
  channel,
  poll,
  question,
}: {
  channel: DraftChannel
  poll: NonNullable<Publication['target']['poll']>
  question?: string
}) {
  return (
    <div
      className="mt-2 grid gap-1.5 rounded-xl border border-border p-3"
      data-testid={`preview-poll-${channel}`}
    >
      {question ? <p className="text-ui-lg font-medium text-foreground">{question}</p> : null}
      {poll.options.map((option, index) => (
        <span
          className="rounded-full border border-sky-400/50 px-3 py-1 text-center text-sm text-sky-700 dark:text-sky-300"
          key={index}
        >
          {option || `Option ${index + 1}`}
        </span>
      ))}
      <p className="text-[11px] text-muted-foreground">
        {channel === 'threads' && poll.durationMinutes === 0
          ? 'Duration set by the platform'
          : poll.durationMinutes >= 1_440
            ? `${poll.durationMinutes / 1_440} day${poll.durationMinutes === 1_440 ? '' : 's'} left`
            : `${poll.durationMinutes} minutes left`}
      </p>
    </div>
  )
}

/** The post a reply answers or a quote embeds, as a card. */
function TargetCard({ target }: { target: DraftTarget }) {
  return (
    <div
      className="mt-2 rounded-xl border border-border p-3 text-sm text-foreground"
      data-testid="preview-target"
    >
      <p className="text-[11px] text-muted-foreground">{target.author ?? target.url}</p>
      {target.text ? (
        <p className="mt-1 line-clamp-3">{target.text}</p>
      ) : (
        <p className="mt-1 text-muted-foreground">Quoted post</p>
      )}
    </div>
  )
}

/** An X (or other thread platform) thread: one post under the other, joined by a line. */
function ThreadPreview({ item, target }: { item: PreviewItem; target: DraftTarget | null }) {
  const { account, publication } = item
  const channel = account.channel
  const posts = publication.serialized.posts
  return (
    <div className={cn('p-3', channel === 'threads' && 'bg-muted/40')} data-platform={channel}>
      {target?.kind === 'reply' ? (
        <p className="mb-2 text-xs text-muted-foreground">
          Replying to {target.author ?? target.url}
        </p>
      ) : null}
      {(posts.length > 0
        ? posts
        : [{ assetIds: [], media: [], caption: '', group: 0, images: 0, length: 0, videos: 0 }]
      ).map((post, index, list) => {
        const settings = publication.settings[index] ?? {}
        return (
          <article className="relative flex gap-3 pb-4" key={index}>
            {index < list.length - 1 ? (
              <span aria-hidden className="absolute top-12 bottom-0 left-5 w-px bg-foreground/15" />
            ) : null}
            <Avatar account={account} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                <span className="font-semibold text-foreground">
                  {account.displayName ?? account.handle ?? CHANNEL_META[channel].label}
                </span>
                {account.handle ? (
                  <span className="ml-1 text-muted-foreground">@{account.handle}</span>
                ) : null}
                <span className="ml-1 text-muted-foreground">· now</span>
              </p>
              <Truncated channel={channel} text={post.caption} />
              {post.media.length === 0 &&
              !settings.poll &&
              target?.kind !== 'quote' &&
              !NO_LINK_CARDS.includes(channel) &&
              !publication.target.options?.linkPreview ? (
                <PreviewLinkCard text={post.caption} />
              ) : null}
              <Media media={post.media} />
              {settings.poll ? <Poll channel={channel} poll={settings.poll} /> : null}
              {(
                index === 0
                  ? publication.target.options?.linkPreview
                  : publication.target.replies?.[index - 1]?.options?.linkPreview
              ) ? (
                <LinkPreviewCard
                  card={
                    (index === 0
                      ? publication.target.options?.linkPreview
                      : publication.target.replies?.[index - 1]?.options?.linkPreview)!
                  }
                />
              ) : null}
              {index === 0 && target?.kind === 'quote' ? <TargetCard target={target} /> : null}
              {settings.quoteFirstPost ? (
                <div className="mt-2 rounded-xl border border-dashed border-input p-2 text-xs text-muted-foreground">
                  Quotes the first post once it is live
                </div>
              ) : null}
              {settings.disclosures?.madeWithAi || settings.disclosures?.paidPartnership ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {[
                    settings.disclosures.paidPartnership ? 'Paid partnership' : '',
                    settings.disclosures.madeWithAi ? 'Made with AI' : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              {settings.replySettings && settings.replySettings !== 'everyone' ? (
                <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-400">
                  Some accounts can’t reply
                </p>
              ) : null}
            </div>
          </article>
        )
      })}
    </div>
  )
}

/** A TikTok post: the video fills a vertical frame, with the account and caption over it. */
function TikTokPost({ item }: { item: PreviewItem }) {
  const { account, publication } = item
  const post = publication.serialized.posts[0]
  const video = post?.media.find((media) => media.kind === 'video')
  return (
    <article
      className="relative mx-auto aspect-[9/16] w-full max-w-[360px] overflow-hidden bg-black text-white"
      data-platform="tiktok"
    >
      {video ? (
        <video
          aria-label={video.alt || 'Attached video'}
          className="absolute inset-0 size-full object-cover"
          controls
          preload="metadata"
          src={assetContentUrl(video.assetId)}
        />
      ) : (
        <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/70">
          A TikTok post needs one video.
        </p>
      )}
      {/* Clear of the video's own controls, and it lets clicks through to them. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-10 bg-gradient-to-t from-black/60 to-transparent p-4 pr-14 [&_*]:!text-white">
        <p className="text-sm font-semibold">
          @{account.handle ?? account.displayName ?? 'tiktok'}
        </p>
        <Truncated channel="tiktok" text={post?.caption ?? ''} />
      </div>
    </article>
  )
}

/** A LinkedIn post: identity, text cut at "more", media, a poll or a PDF document. */
function LinkedInPost({ item, target }: { item: PreviewItem; target: DraftTarget | null }) {
  const { account, publication } = item
  const post = publication.serialized.posts[0]
  const options = publication.target.options
  return (
    <article className="bg-muted/40 p-3 text-foreground">
      <header className="flex items-center gap-2">
        <Avatar account={account} size="size-12" />
        <div className="min-w-0">
          <p className="truncate text-ui-lg font-semibold">
            {account.displayName ?? account.handle ?? 'LinkedIn'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            now · {options?.visibility === 'CONNECTIONS' ? 'Connections only' : 'Anyone'}
          </p>
        </div>
      </header>
      <div className="mt-2">
        <Truncated channel="linkedin" text={post?.caption ?? ''} />
      </div>
      {post ? <Media media={post.media} /> : null}
      {publication.target.poll ? (
        <Poll channel="linkedin" poll={publication.target.poll} question={options?.pollQuestion} />
      ) : null}
      {options?.documentAssetId ? (
        <div className="mt-2">
          <PdfCarousel assetId={options.documentAssetId} />
        </div>
      ) : null}
      {target?.kind === 'quote' ? <TargetCard target={target} /> : null}
      {options?.firstComment ? (
        <div className="mt-3 rounded-lg bg-foreground/5 p-2 text-xs text-foreground">
          <span className="text-muted-foreground">First comment: </span>
          {options.firstComment}
        </div>
      ) : null}
    </article>
  )
}

/** The article body comes exclusively from articleContent's escaped allowlisted serializer. */
function ArticlePreview({ item }: { item: PreviewItem }) {
  const options = item.publication.target.options!
  const html = (options.articleHtml ?? '').replace(
    /data-asset-id="([a-z0-9-]+)"/g,
    (_, id: string) => `src="${assetContentUrl(id)}"`
  )
  return (
    <article className="p-4" data-testid="article-preview">
      {options.articleCoverAssetId ? (
        <img
          alt="Article cover"
          className="mb-4 aspect-video rounded-lg object-cover"
          src={assetContentUrl(options.articleCoverAssetId)}
        />
      ) : null}
      <h1 className="mb-3 text-2xl font-bold">{options.articleTitle}</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        {item.account.displayName ?? item.account.handle}
      </p>
      <div
        className="prose prose-invert max-w-none [&_p]:mb-3 [&_h1]:text-2xl [&_h2]:text-xl [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_a]:text-sky-400 [&_img]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  )
}

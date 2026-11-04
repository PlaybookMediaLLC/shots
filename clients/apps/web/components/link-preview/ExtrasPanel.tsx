'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { XCircleIcon as XCircle } from '@phosphor-icons/react/dist/ssr/XCircle'
import type { ReactNode } from 'react'
import { Pill } from '@/components/platform-ui'
import type { LinkPreview } from '@/lib/api/contracts/link-preview'
import {
  appLinks,
  articleMeta,
  HREFLANG,
  iconLinks,
  languageAlternates,
  oembedLink,
  videoMeta,
} from '@/lib/link-preview/extras'
import { cn } from '@/lib/utils'
import { PANEL } from './MetadataPanels'

function Section({
  children,
  description,
  empty,
  title,
}: {
  children?: ReactNode
  description: string
  /** Shown instead of the rows when the page declares none of these tags. */
  empty?: string
  title: string
}) {
  return (
    <section className={cn(PANEL, 'p-6')}>
      <h3 className="text-ui-lg font-medium text-foreground">{title}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{description}</p>
      {empty ? <p className="text-sm text-muted-foreground">{empty}</p> : <dl>{children}</dl>}
    </section>
  )
}

function Row({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/[0.07] py-2.5 last:border-b-0">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-sm text-foreground">
        {value || <span className="text-muted-foreground">Not set</span>}
      </dd>
    </div>
  )
}

const anyOf = (values: object) =>
  Object.values(values).some((value) => (Array.isArray(value) ? value.length : value))

function date(value?: string) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? (
    <span className="text-amber-400">{value} (not a date)</span>
  ) : (
    `${new Date(parsed).toLocaleString()} · ${value}`
  )
}

/**
 * The tags beyond the basic card: video and player cards, article details,
 * app links, alternate languages, icons and the manifest, and oEmbed.
 */
export function ExtrasPanel({ preview }: { preview: LinkPreview }) {
  const video = videoMeta(preview)
  const article = articleMeta(preview)
  const apps = appLinks(preview)
  const alternates = languageAlternates(preview)
  const { icons, manifest } = iconLinks(preview)
  const { oembed } = preview
  const discovered = oembedLink(preview)

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section
        title="Video and player cards"
        description="Playable media for Facebook, LinkedIn, and X's player card."
        empty={anyOf(video) ? undefined : 'No og:video or twitter:player tags.'}
      >
        <Row label="og:video" value={video.ogVideo} />
        <Row label="og:video:secure_url" value={video.ogVideoSecureUrl} />
        <Row label="og:video:type" value={video.ogVideoType} />
        <Row
          label="Video size"
          value={video.ogVideoWidth && `${video.ogVideoWidth} × ${video.ogVideoHeight ?? '?'}`}
        />
        <Row label="twitter:player" value={video.twitterPlayer} />
        <Row
          label="Player size"
          value={
            video.twitterPlayerWidth &&
            `${video.twitterPlayerWidth} × ${video.twitterPlayerHeight ?? '?'}`
          }
        />
        <Row label="twitter:player:stream" value={video.twitterPlayerStream} />
      </Section>

      <Section
        title="Article"
        description="Dates, authors, and topics that LinkedIn, Facebook, and search show for posts."
        empty={
          anyOf(article) || preview.ogType?.toLowerCase() === 'article'
            ? undefined
            : 'Not an article, and no article tags.'
        }
      >
        <Row label="Published" value={date(article.publishedTime)} />
        <Row label="Modified" value={date(article.modifiedTime)} />
        <Row label="Authors" value={article.authors.join(', ')} />
        <Row label="Section" value={article.section} />
        <Row
          label="Tags"
          value={
            article.tags.length > 0 && (
              <span className="inline-flex flex-wrap justify-end gap-1">
                {article.tags.map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
              </span>
            )
          }
        />
      </Section>

      <Section
        title="App links"
        description="Deep links that open your iOS or Android app from a shared link, and the iOS Smart App Banner."
        empty={anyOf(apps) ? undefined : 'No app link or Smart App Banner tags.'}
      >
        <Row label="iOS URL" value={apps.iosUrl} />
        <Row label="App Store ID" value={apps.iosAppStoreId} />
        <Row label="iOS app name" value={apps.iosAppName} />
        <Row label="Android URL" value={apps.androidUrl} />
        <Row label="Android package" value={apps.androidPackage} />
        <Row label="Smart App Banner" value={apps.smartBanner} />
        <Row label="X app (iPhone)" value={apps.twitterAppIphone} />
        <Row label="X app (Google Play)" value={apps.twitterAppGooglePlay} />
      </Section>

      <Section
        title="Languages (hreflang)"
        description="Other language versions of the page, so search and platforms send people to the right one."
        empty={alternates.length ? undefined : 'No hreflang alternates.'}
      >
        {alternates.map((alternate) => (
          <Row
            key={`${alternate.hreflang}-${alternate.href}`}
            label={alternate.hreflang}
            value={
              <span className="inline-flex items-center gap-1.5">
                {!HREFLANG.test(alternate.hreflang) && (
                  <Pill tone="yellow">Not a language code</Pill>
                )}
                {alternate.href}
              </span>
            }
          />
        ))}
      </Section>

      <Section
        title="Icons and manifest"
        description="Favicons, the iOS home-screen icon iMessage also uses, and the web app manifest."
      >
        {icons.map((icon) => (
          <Row
            key={`${icon.rel}-${icon.href}`}
            label={icon.rel}
            value={
              <span className="inline-flex items-center gap-2">
                <img
                  src={icon.href}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-6 rounded bg-white/5 object-contain"
                />
                <span className="text-muted-foreground">
                  {[icon.sizes, icon.type].filter(Boolean).join(' · ') || 'no sizes'}
                </span>
              </span>
            }
          />
        ))}
        <Row
          label="apple-touch-icon"
          value={
            icons.some((icon) => icon.rel.startsWith('apple-touch-icon')) ? (
              <Check className="ml-auto size-4 text-emerald-400" aria-label="Present" />
            ) : (
              <XCircle className="ml-auto size-4 text-amber-400" aria-label="Missing" />
            )
          }
        />
        <Row label="Manifest" value={manifest} />
      </Section>

      <Section
        title="oEmbed"
        description="The embed description Slack, Discord, Notion, and WordPress read when a page offers one."
        empty={discovered ? undefined : 'The page links no oEmbed endpoint.'}
      >
        <Row label="Endpoint" value={discovered} />
        {oembed?.error ? (
          <Row label="Result" value={<span className="text-red-400">{oembed.error}</span>} />
        ) : (
          <>
            <Row label="Type" value={oembed?.type} />
            <Row label="Provider" value={oembed?.providerName} />
            <Row label="Title" value={oembed?.title} />
            <Row label="Author" value={oembed?.authorName} />
            <Row label="Thumbnail" value={oembed?.thumbnailUrl} />
            <Row
              label="Embeddable HTML"
              value={oembed?.hasHtml ? 'Yes' : oembed ? 'No' : undefined}
            />
          </>
        )}
      </Section>
    </div>
  )
}

'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/ssr/Copy'
import { ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  CHANNELS,
  postLength,
  type ShareChannel,
  shareChannelSchema,
  trackedLink,
} from '@/lib/link-preview/share'
import { cn } from '@/lib/utils'
import { copyText } from './client'
import { PANEL } from './MetadataPanels'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'

const C = shareChannelSchema.enum
/** Channels whose post length matters, shown under the composer. */
const COUNTED: ShareChannel[] = [C.x, C.bluesky, C.threads, C.mastodon, C.linkedin]

const INPUT =
  'w-full rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-foreground ring-1 ring-white/[0.08] outline-none placeholder:text-muted-foreground focus:ring-white/25'

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={async () => {
        if (!(await copyText(text))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
    </Button>
  )
}

/** The post that goes with the link, with its length on each platform. */
export function PostComposer({
  onChange,
  post,
  url,
}: {
  onChange: (post: string) => void
  post: string
  url: string
}) {
  return (
    <section className={cn(PANEL, 'space-y-3 p-4')}>
      <Label className="block space-y-1.5">
        <span className="text-xs text-muted-foreground">
          Post text · shows above every card, and fills the share links on the Share tab
        </span>
        <Textarea
          value={post}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          placeholder="Write the post that goes with the link…"
          className={cn(INPUT, 'resize-y')}
        />
      </Label>
      <ul className="flex flex-wrap gap-2 text-xs">
        {COUNTED.map((channel) => {
          const { limit, linkLength, name } = CHANNELS[channel]
          const length = postLength(post, channel, url)
          const over = limit !== undefined && length > limit
          return (
            <li
              key={channel}
              title={
                linkLength ? `${name} counts the link as ${linkLength} characters.` : undefined
              }
              className={cn(
                'rounded-full px-2.5 py-1 tabular-nums ring-1 ring-inset',
                over
                  ? 'bg-red-500/10 text-red-300 ring-red-500/20'
                  : 'bg-white/[0.04] text-muted-foreground ring-white/10'
              )}
            >
              {name} {length}
              {limit ? ` / ${limit}` : ''}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/**
 * Tracked links for every channel, ready to copy, and a button that opens
 * each platform's composer with the link and post filled in.
 */
export function SharePanel({
  canonical,
  campaign,
  content,
  onCampaignChange,
  onContentChange,
  post,
  url,
}: {
  /** Whether the page declares a canonical URL, so tracked links keep one search identity. */
  canonical: boolean
  campaign: string
  content: string
  onCampaignChange: (value: string) => void
  onContentChange: (value: string) => void
  post: string
  url: string
}) {
  const rows = shareChannelSchema.options.map((channel) => ({
    channel,
    link: trackedLink(url, channel, { campaign, content }),
  }))
  const all = rows.map(({ channel, link }) => `${CHANNELS[channel].name}: ${link}`).join('\n')

  return (
    <div className="space-y-6">
      <section className={cn(PANEL, 'grid gap-4 p-5 sm:grid-cols-2')}>
        <Label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">Campaign (utm_campaign)</span>
          <Input
            value={campaign}
            onChange={(event) => onCampaignChange(event.target.value)}
            placeholder="spring-launch"
            className={INPUT}
          />
          <span className="block break-all text-xs text-muted-foreground">Final value: {campaign.trim() || '(none)'}</span>
        </Label>
        <Label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">Variant (utm_content, optional)</span>
          <Input
            value={content}
            onChange={(event) => onContentChange(event.target.value)}
            placeholder="hero-image"
            className={INPUT}
          />
          <span className="block break-all text-xs text-muted-foreground">Final value: {content.trim() || '(none)'}</span>
        </Label>
        <p
          className={cn(
            'text-xs sm:col-span-2',
            canonical ? 'text-muted-foreground' : 'text-amber-300'
          )}
        >
          {canonical
            ? 'The page declares a canonical URL, so search engines credit one address however the link is tagged.'
            : 'The page has no canonical URL. Add one, or each tagged link may be indexed as a separate page.'}
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-ui-lg font-medium text-foreground">Tracked links</h3>
          <CopyAll text={all} />
        </div>
        <ul className={cn(PANEL, 'divide-y divide-white/[0.07]')}>
          {rows.map(({ channel, link }) => {
            const { intent, name } = CHANNELS[channel]
            return (
              <li key={channel} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="w-20 shrink-0 text-ui-lg font-medium text-foreground">{name}</span>
                <code className="order-last w-full break-all font-mono text-xs text-muted-foreground sm:order-none sm:w-auto sm:min-w-0 sm:flex-1">
                  {link}
                </code>
                <CopyIcon text={link} label={`Copy the ${name} link`} />
                <span className="flex w-[72px] shrink-0 justify-end">
                  {intent && (
                    <a
                      href={intent(link, post)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground ring-1 ring-white/10 hover:bg-white/[0.05]"
                    >
                      Share
                      <ExternalLink className="size-3.5" />
                    </a>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          Share opens the platform&apos;s own composer with your post and tracked link. Nothing is
          posted until you send it there.
        </p>
      </section>
    </div>
  )
}

function CopyAll({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={async () => {
        if (!(await copyText(text))) return
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
    >
      {copied ? <Check className="text-emerald-500" /> : <Copy />}
      {copied ? 'Copied' : 'Copy all'}
    </Button>
  )
}

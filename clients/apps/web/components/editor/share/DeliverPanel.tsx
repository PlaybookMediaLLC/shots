'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type Integration,
  integrationSchema,
  parseFigmaUrl,
  PROVIDER_NAMES,
} from '@/lib/integrations/schema'
import type { ShareLink } from '@/lib/sharing/schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

type Channel = { id: string; isMember: boolean; isPrivate: boolean; name: string }
type Page = { id: string; title: string; url: string | null }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'That did not go through. Try again.'
}

const SELECT =
  'h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** Put a PNG of the design on the clipboard; Figma (and most apps) paste it as an image. */
async function copyImage(render: () => Promise<Blob>) {
  try {
    const blob = await render()
    const png = blob.type === 'image/png' ? blob : await toPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    toast.success('Copied the image. Paste it into Figma with ⌘V.')
  } catch (error) {
    toast.error('Could not copy the image', { description: errorMessage(error) })
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (png) => (png ? resolve(png) : reject(new Error('PNG encoding failed.'))),
      'image/png'
    )
  )
}

/** Send a published link to a connected Slack channel, Notion page, or Figma file. */
export function DeliverPanel({ link, render }: { link: ShareLink; render: () => Promise<Blob> }) {
  const trpcClient = useTRPCClient()
  const [integrations, setIntegrations] = React.useState<Integration[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    trpcClient.integration.list
      .query()
      .then((result) =>
        setIntegrations(result.integrations.map((item) => integrationSchema.parse(item)))
      )
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }, [trpcClient])

  async function deliver(
    integration: Integration,
    target: Parameters<typeof trpcClient.integration.deliver.mutate>[0]['target']
  ) {
    try {
      const result = await trpcClient.integration.deliver.mutate({
        integrationId: integration.id,
        shareLinkId: link.id,
        target,
      })
      toast.success(
        `Sent to ${result.label}`,
        result.url
          ? {
              action: {
                label: 'Open',
                onClick: () => window.open(result.url!, '_blank', 'noopener'),
              },
            }
          : undefined
      )
    } catch (failure) {
      toast.error(`Could not send to ${PROVIDER_NAMES[integration.provider]}`, {
        description: errorMessage(failure),
      })
      throw failure
    }
  }

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between">
        <span className="text-ui-lg font-medium">Send to</span>
        <Button onClick={() => void copyImage(render)} size="sm" type="button" variant="outline">
          Copy image for Figma
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : integrations === null ? (
        <p className="text-xs text-muted-foreground">Loading connections…</p>
      ) : integrations.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Connect Slack, Notion, or Figma in{' '}
          <Link className="underline" href="/workspace/integrations">
            workspace integrations
          </Link>{' '}
          to send published designs there.
        </p>
      ) : (
        <ul className="grid gap-3">
          {integrations.map((integration) => (
            <li className="rounded-lg border border-foreground/10 p-3" key={integration.id}>
              <p className="mb-2 text-xs font-medium">
                {PROVIDER_NAMES[integration.provider]} · {integration.displayName}
              </p>
              {integration.provider === 'SLACK' ? (
                <SlackTarget
                  integration={integration}
                  onSend={(target) => deliver(integration, target)}
                />
              ) : integration.provider === 'NOTION' ? (
                <NotionTarget
                  integration={integration}
                  onSend={(target) => deliver(integration, target)}
                />
              ) : (
                <FigmaTarget onSend={(target) => deliver(integration, target)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

type Send<T> = (target: T) => Promise<void>

function SlackTarget({
  integration,
  onSend,
}: {
  integration: Integration
  onSend: Send<{ channelId: string; kind: 'slack'; message?: string }>
}) {
  const trpcClient = useTRPCClient()
  const [channels, setChannels] = React.useState<Channel[] | null>(null)
  const [channelId, setChannelId] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  React.useEffect(() => {
    trpcClient.integration.slackChannels
      .query({ integrationId: integration.id })
      .then((result) => {
        setChannels(result.channels)
        setChannelId((current) => current || result.channels[0]?.id || '')
      })
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }, [integration.id, trpcClient])

  const chosen = channels?.find((channel) => channel.id === channelId)
  return (
    <div className="grid gap-2">
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Select
        disabled={!channels}
        onValueChange={(nextValue) => setChannelId(nextValue)}
        value={channelId}
      >
        <SelectTrigger aria-label="Slack channel" className={SELECT}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(channels ?? []).map((channel) => (
            <SelectItem key={channel.id} value={channel.id}>
              {channel.isPrivate ? '🔒 ' : '#'}
              {channel.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen?.isPrivate && !chosen.isMember ? (
        <p className="text-xs text-muted-foreground">
          Invite the app to this private channel in Slack first (/invite).
        </p>
      ) : null}
      <Input
        aria-label="Slack message"
        maxLength={3000}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Message (optional)"
        value={message}
      />
      <Button
        disabled={!channelId || sending}
        onClick={() => {
          setSending(true)
          onSend({ channelId, kind: 'slack', message: message || undefined })
            .catch(() => undefined)
            .finally(() => setSending(false))
        }}
        size="sm"
        type="button"
      >
        {sending ? 'Sending…' : 'Send to Slack'}
      </Button>
    </div>
  )
}

function NotionTarget({
  integration,
  onSend,
}: {
  integration: Integration
  onSend: Send<{ kind: 'notion'; pageId: string }>
}) {
  const trpcClient = useTRPCClient()
  const [query, setQuery] = React.useState('')
  const [pages, setPages] = React.useState<Page[] | null>(null)
  const [pageId, setPageId] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  React.useEffect(() => {
    const timer = setTimeout(() => {
      trpcClient.integration.notionPages
        .query({ integrationId: integration.id, query })
        .then((result) => {
          setPages(result.pages)
          setError(null)
        })
        .catch((failure: unknown) => setError(errorMessage(failure)))
    }, 250)
    return () => clearTimeout(timer)
  }, [integration.id, query, trpcClient])

  return (
    <div className="grid gap-2">
      <Input
        aria-label="Search Notion pages"
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search pages shared with the integration"
        value={query}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <ul
        aria-label="Notion pages"
        className="max-h-36 overflow-y-auto rounded-md border border-foreground/10"
        role="listbox"
      >
        {(pages ?? []).map((page) => (
          <li
            aria-selected={page.id === pageId}
            className={cn(
              'cursor-pointer truncate px-2 py-1.5 text-xs hover:bg-accent',
              page.id === pageId && 'bg-accent'
            )}
            key={page.id}
            onClick={() => setPageId(page.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setPageId(page.id)
            }}
            role="option"
            tabIndex={0}
          >
            {page.title}
          </li>
        ))}
        {pages?.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No pages. In Notion, share a page with the integration (••• → Connections).
          </li>
        ) : null}
      </ul>
      <Button
        disabled={!pageId || sending}
        onClick={() => {
          setSending(true)
          onSend({ kind: 'notion', pageId })
            .catch(() => undefined)
            .finally(() => setSending(false))
        }}
        size="sm"
        type="button"
      >
        {sending ? 'Adding…' : 'Add to Notion page'}
      </Button>
    </div>
  )
}

function FigmaTarget({
  onSend,
}: {
  onSend: Send<{ fileUrl: string; kind: 'figma'; message?: string }>
}) {
  const [fileUrl, setFileUrl] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const valid = parseFigmaUrl(fileUrl) !== null
  return (
    <div className="grid gap-2">
      <Input
        aria-invalid={fileUrl !== '' && !valid}
        aria-label="Figma file or frame link"
        onChange={(event) => setFileUrl(event.target.value)}
        placeholder="https://www.figma.com/design/…?node-id=…"
        value={fileUrl}
      />
      {fileUrl && !valid ? (
        <p className="text-xs text-destructive">Paste a link to a Figma file or frame.</p>
      ) : null}
      <Input
        aria-label="Figma comment"
        maxLength={3000}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Comment (optional)"
        value={message}
      />
      <p className="text-xs text-muted-foreground">
        Figma&apos;s API adds comments, not images: this pins a comment with the link on the frame.
        Use “Copy image for Figma” to paste the design itself.
      </p>
      <Button
        disabled={!valid || sending}
        onClick={() => {
          setSending(true)
          onSend({ fileUrl, kind: 'figma', message: message || undefined })
            .catch(() => undefined)
            .finally(() => setSending(false))
        }}
        size="sm"
        type="button"
      >
        {sending ? 'Commenting…' : 'Comment in Figma'}
      </Button>
    </div>
  )
}

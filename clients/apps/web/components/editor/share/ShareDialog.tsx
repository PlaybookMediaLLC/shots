'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { ChoiceField } from '@/components/editor/inspector/fields'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CHANNELS, shareChannelSchema } from '@/lib/link-preview/share'
import { useProjectSession } from '@/lib/projects/session'
import { useImageStore } from '@/lib/store'
import {
  embedSnippets,
  SHARE_ACCESS_LABELS,
  SHARE_EXPIRY_LABELS,
  type ShareAccess,
  shareAccessSchema,
  type ShareExpiry,
  shareExpirySchema,
  type ShareLink,
  shareLinkSchema,
  shareUrl,
} from '@/lib/sharing/schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { buildExportFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { DeliverPanel } from './DeliverPanel'

const C = shareChannelSchema.enum
const INTENTS = [C.x, C.linkedin, C.bluesky, C.threads, C.reddit, C.email] as const

type Snippet = keyof ReturnType<typeof embedSnippets>
const SNIPPETS: readonly { label: string; value: Snippet }[] = [
  { label: 'iframe', value: 'iframe' },
  { label: 'HTML', value: 'html' },
  { label: 'Markdown', value: 'markdown' },
]

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Publishing failed. Try again.'
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`Copied ${what}`)
  } catch {
    toast.error('The clipboard is not available here. Select the text and copy it.')
  }
}

/**
 * Publish the design at a link: the export uploads to the workspace, and the
 * link page previews as that image wherever it is pasted. Then copy the link
 * or an embed, check its preview, post it, or send it to Slack, Notion, or Figma.
 */
export function ShareDialog({
  defaultTitle,
  onOpenChange,
  open,
  render,
}: {
  defaultTitle?: string
  onOpenChange: (open: boolean) => void
  open: boolean
  /** The design as the file to publish, rendered by the export pipeline. */
  render: () => Promise<Blob>
}) {
  const trpcClient = useTRPCClient()
  const project = useProjectSession()
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [altText, setAltText] = React.useState('')
  const [access, setAccess] = React.useState<ShareAccess>('WORKSPACE')
  const [expiry, setExpiry] = React.useState<ShareExpiry>('7d')
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [link, setLink] = React.useState<ShareLink | null>(null)
  const [snippet, setSnippet] = React.useState<Snippet>('iframe')
  const ids = {
    alt: React.useId(),
    description: React.useId(),
    title: React.useId(),
    url: React.useId(),
  }

  React.useEffect(() => {
    if (!open) return
    // Captions and alt text written in the AI panel fill the link's text.
    const copy = useImageStore.getState().copy
    setTitle(project.name || defaultTitle || 'Untitled design')
    setDescription(copy?.captions.linkedin ?? Object.values(copy?.captions ?? {})[0] ?? '')
    setAltText(copy?.altText ?? '')
    setLink(null)
    setError(null)
  }, [defaultTitle, open, project.name])

  async function publish(event: React.FormEvent) {
    event.preventDefault()
    if (!title.trim()) {
      setError('Add a title.')
      return
    }
    setPending(true)
    setError(null)
    try {
      const blob = await render()
      const { assetId } = await saveExportToWorkspace({
        blob,
        classification: 'export',
        projectId: project.projectId ?? undefined,
        fileName: buildExportFileName(blob.type),
        trpcClient,
      })
      const { shareLink } = await trpcClient.shareLink.create.mutate({
        access,
        altText: altText.trim() || undefined,
        assetId,
        description: description.trim() || undefined,
        expiry,
        projectId: project.projectId ?? undefined,
        title: title.trim(),
      })
      setLink(shareLinkSchema.parse(shareLink))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(false)
    }
  }

  async function revoke() {
    if (!link) return
    try {
      await trpcClient.shareLink.revoke.mutate({ id: link.id })
      toast.success('The link is off')
      setLink(null)
    } catch (failure) {
      toast.error(errorMessage(failure))
    }
  }

  const url = link ? shareUrl(window.location.origin, link.token) : ''
  const snippets = link ? embedSnippets(window.location.origin, link) : null
  const postText = description.trim() || title.trim()

  return (
    <Dialog onOpenChange={pending ? undefined : onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-background sm:max-w-[560px]">
        {!link ? (
          <form className="grid gap-4" onSubmit={publish}>
            <DialogHeader>
              <DialogTitle>Share design</DialogTitle>
              <DialogDescription>
                Publishes this design as an image at a link. Anyone you choose can open it; you can
                revoke it any time.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={ids.title}>Title</Label>
              <Input
                id={ids.title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.description}>Description</Label>
              <Textarea
                id={ids.description}
                maxLength={5000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Shown on the link page and in link previews."
                rows={2}
                value={description}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={ids.alt}>Alt text</Label>
              <Textarea
                id={ids.alt}
                maxLength={1500}
                onChange={(event) => setAltText(event.target.value)}
                placeholder="Describe the image for people using screen readers."
                rows={2}
                value={altText}
              />
            </div>
            <ChoiceField
              label="Who can open it"
              onChange={setAccess}
              options={shareAccessSchema.options.map((value) => ({
                label: SHARE_ACCESS_LABELS[value],
                value,
              }))}
              value={access}
            />
            <ChoiceField
              label="Link expires"
              onChange={setExpiry}
              options={shareExpirySchema.options.map((value) => ({
                label: SHARE_EXPIRY_LABELS[value],
                value,
              }))}
              value={expiry}
            />
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={pending}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={pending} type="submit">
                {pending ? 'Publishing…' : 'Publish link'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-5">
            <DialogHeader>
              <DialogTitle>Published</DialogTitle>
              <DialogDescription>
                {SHARE_ACCESS_LABELS[link.access]}
                {link.expiresAt ? `, until ${link.expiresAt.toLocaleString()}` : ''}.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              <Label htmlFor={ids.url}>Link</Label>
              <div className="flex gap-2">
                <Input
                  id={ids.url}
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={url}
                />
                <Button onClick={() => void copy(url, 'link')} type="button">
                  Copy
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" variant="outline">
                  <a href={url} rel="noopener noreferrer" target="_blank">
                    Open
                  </a>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <a
                    href={`/publish/link-checks?${new URLSearchParams({ url })}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Check link preview
                  </a>
                </Button>
              </div>
            </div>

            {snippets ? (
              <div className="grid gap-2">
                <ChoiceField
                  label="Embed"
                  onChange={setSnippet}
                  options={SNIPPETS}
                  value={snippet}
                />
                <Textarea
                  aria-label="Embed code"
                  className="font-mono text-xs"
                  readOnly
                  rows={3}
                  value={snippets[snippet]}
                />
                <Button
                  onClick={() => void copy(snippets[snippet], 'embed code')}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Copy embed code
                </Button>
              </div>
            ) : null}

            {link.access === 'PUBLIC' ? (
              <div className="grid gap-2">
                <span className="text-ui-lg font-medium">Post</span>
                <div className="flex flex-wrap gap-2">
                  {INTENTS.map((channel) => {
                    const intent = CHANNELS[channel].intent
                    return intent ? (
                      <Button asChild key={channel} size="sm" variant="outline">
                        <a href={intent(url, postText)} rel="noopener noreferrer" target="_blank">
                          {CHANNELS[channel].name}
                        </a>
                      </Button>
                    ) : null
                  })}
                </div>
              </div>
            ) : null}

            <DeliverPanel link={link} render={render} />

            <DialogFooter className="sm:justify-between">
              <Button onClick={() => void revoke()} type="button" variant="ghost">
                Revoke link
              </Button>
              <Button onClick={() => onOpenChange(false)} type="button">
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

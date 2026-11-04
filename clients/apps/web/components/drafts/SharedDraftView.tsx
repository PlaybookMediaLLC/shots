'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { LocalTime } from './local-time'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** A guest's comment, as the share page shows it. */
export type GuestComment = { createdAt: string; name: string; text: string }

/**
 * A shared draft as a guest sees it: the text, the comments guests left,
 * and a form to add one. The link is the only credential.
 */
export function SharedDraftView({
  comments: initialComments,
  published = false,
  publishedUrl,
  text,
  title,
  token,
}: {
  published?: boolean
  publishedUrl?: string | null
  comments: GuestComment[]
  text: string
  title: string
  token: string
}) {
  const [comments, setComments] = React.useState(initialComments)
  const [name, setName] = React.useState('')
  const [comment, setComment] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setSending(true)
    try {
      const response = await fetch(`/api/drafts/shared/${encodeURIComponent(token)}/comments`, {
        body: JSON.stringify({ name, text: comment }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const body = (await response.json()) as {
        guestComments?: GuestComment[]
        message?: string
      }
      if (!response.ok) throw new Error(body.message ?? 'The comment could not be sent.')
      setComments(body.guestComments ?? comments)
      setComment('')
      toast.success('Thanks — your comment is with the team.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The comment could not be sent.')
    } finally {
      setSending(false)
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-8 px-6 py-12 text-foreground">
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {published ? 'Published thread · reading view' : 'Draft shared for feedback'}
        </p>
        {publishedUrl && (
          <a
            className="text-sm underline"
            href={publishedUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open original post
          </a>
        )}
        <h1 className="mt-1 text-xl font-medium text-foreground">{title}</h1>
      </header>
      <article
        className="whitespace-pre-wrap rounded-xl border border-foreground/[0.08] bg-foreground/[0.02] p-5 text-[15px] leading-relaxed"
        data-testid="shared-draft"
      >
        {text || 'This draft is empty.'}
      </article>
      <section className="flex flex-col gap-3">
        <h2 className="text-ui-lg font-medium text-foreground">Comments</h2>
        {comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {comments.map((item) => (
              <li
                className="rounded-lg border border-foreground/[0.06] px-3 py-2"
                key={`${item.createdAt}-${item.name}`}
              >
                <p className="text-xs text-muted-foreground">
                  <span className="text-foreground">{item.name}</span> ·{' '}
                  <LocalTime value={item.createdAt} />
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm">{item.text}</p>
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-col gap-2" onSubmit={send}>
          <Input
            aria-label="Your name"
            className="h-9 rounded-md border border-foreground/[0.08] bg-transparent px-3 text-sm"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Your name"
            required
            value={name}
          />
          <Textarea
            aria-label="Your comment"
            className="min-h-24 rounded-md border border-foreground/[0.08] bg-transparent p-3 text-sm"
            maxLength={2000}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What do you think?"
            required
            value={comment}
          />
          <div>
            <Button disabled={sending} type="submit">
              {sending ? 'Sending…' : 'Send comment'}
            </Button>
          </div>
        </form>
      </section>
    </main>
  )
}

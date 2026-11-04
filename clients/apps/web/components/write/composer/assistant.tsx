'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { call } from '@/lib/content-drafts/client'
import { WRITING_PROMPTS } from '@/lib/write/prompt-library'
import { assistPosts } from '@/lib/write/refine-actions'
import { VoiceMemo } from './voice-memo'
import type { DraftChannel } from '@/lib/write/document'
import { useWrite, type WriteSet } from '../write-context'

/** One turn of the conversation. */
type Turn = { content: string; role: 'assistant' | 'user' }

/** Starting points for a conversation about the draft. */
const STARTERS = [
  'Give me three stronger hooks for the first post.',
  'How could the ending get more replies?',
  'What is unclear or too long here?',
  'Adapt this for LinkedIn.',
  'Continue this unfinished thought using only the facts in this draft.',
  'Give constructive feedback on clarity, evidence, and audience fit. Do not rewrite yet.',
  'Suggest a concise call to action that follows naturally from this draft.',
  'Suggest two relevant emoji and explain where each fits.',
]

/**
 * The writing assistant (RFC 025): a conversation about the open draft in
 * the set's voice, from its Writing Assistant (RFC 024): the workspace brand
 * refined by the set's style guide and samples, merged by the backend. The
 * conversation stays in this panel; nothing in the draft changes unless the
 * writer adds a reply to it. Each answer uses the workspace's AI credits.
 */
export function AssistantPanel({
  channel,
  draftId,
  onInsert,
  posts,
  set,
}: {
  channel: DraftChannel
  draftId: string
  /** Add a reply to the draft as a new post. */
  onInsert?: (text: string) => void
  /** The draft's posts as the platform reads them. */
  posts: string[]
  set: WriteSet | null
}) {
  const [turns, setTurns] = React.useState<Turn[]>([])
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [setup, setSetup] = React.useState(false)
  const [skipped, setSkipped] = React.useState(false)
  const configured = set?.writingAssistant.status === 'configured'
  const send = async (text: string) => {
    const content = text.trim()
    if (!content || busy) return
    const next: Turn[] = [...turns, { content, role: 'user' }]
    setTurns(next)
    setMessage('')
    setBusy(true)
    try {
      const answer = await call<{ reply: string }>('/api/v1/content-drafts/assistant', {
        body: { channel, draft: posts, draftId, messages: next.slice(-30) },
        method: 'POST',
      })
      setTurns([...next, { content: answer.reply, role: 'assistant' }])
    } catch (error) {
      setTurns(turns)
      setMessage(content)
      toast.error(error instanceof Error ? error.message : 'The assistant could not answer.')
    } finally {
      setBusy(false)
    }
  }
  if (setup || (!configured && !skipped && turns.length === 0 && set)) {
    return (
      <AssistantSetup
        onDone={() => {
          setSetup(false)
          setSkipped(true)
        }}
        set={set}
      />
    )
  }
  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm" data-testid="assistant-panel">
      <p className="text-xs text-muted-foreground">
        Writing in {set?.name ?? 'this set'}’s voice
        {configured ? '' : ' (no style guide yet)'}.{' '}
        <Button
          className="text-sky-700 dark:text-sky-300"
          onClick={() => setSetup(true)}
          size={null}
          type="button"
          variant="custom"
        >
          Style guide and samples
        </Button>
      </p>
      <p className="text-xs text-muted-foreground">
        Workspace defaults → Publishing brand overrides → Your instructions for this draft. Prohibited
        terms always apply.
      </p>
      <Label className="grid gap-1 text-xs">
        Prompt library
        <Select value="" onValueChange={(value) => setMessage(value)}>
          <SelectTrigger aria-label="Prompt library">
            <SelectValue placeholder="Choose an instruction…" />
          </SelectTrigger>
          <SelectContent>
            {STARTERS.map((starter) => (
              <SelectItem key={starter} value={starter}>
                {starter}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>
      <Disclosure className="rounded-lg border border-border p-3">
        <DisclosureTrigger>Writing prompts and examples</DisclosureTrigger>
        <DisclosureContent>
          <p className="my-2 text-xs text-muted-foreground">Examples show a structure. Use your own facts and experience.</p>
          <ul className="grid gap-3">
            {WRITING_PROMPTS.map((prompt) => (
              <li key={prompt.id}>
                <Button type="button" variant="outline" size="sm" onClick={() => setMessage(prompt.instruction)}>{prompt.title}</Button>
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{prompt.example}</p>
              </li>
            ))}
          </ul>
        </DisclosureContent>
      </Disclosure>
      {turns.length === 0 ? (
        <VoiceMemo draftId={draftId} channel={channel} onUse={setMessage} />
      ) : null}
      {turns.length === 0 ? (
        <div className="grid gap-1.5">
          {STARTERS.map((starter) => (
            <Button
              className="h-auto justify-start whitespace-normal rounded-lg border border-border px-3 py-2 text-left text-xs"
              key={starter}
              onClick={() => void send(starter)}
              size={null}
              type="button"
              variant="ghost"
            >
              {starter}
            </Button>
          ))}
        </div>
      ) : (
        <ol aria-live="polite" className="grid gap-3">
          {turns.map((turn, index) => (
            <li
              className={
                turn.role === 'user'
                  ? 'ml-6 rounded-lg bg-foreground/[0.06] px-3 py-2'
                  : 'rounded-lg border border-border px-3 py-2'
              }
              data-testid={`assistant-${turn.role}`}
              key={index}
            >
              <p className="whitespace-pre-wrap text-foreground">{turn.content}</p>
              {turn.role === 'assistant' ? (
                <p className="mt-1.5 flex gap-2 text-xs">
                  {onInsert ? (
                    <Button
                      className="text-sky-700 dark:text-sky-300"
                      // Only the post goes in: never the model's introduction.
                      onClick={() => assistPosts(turn.content).forEach(onInsert)}
                      size={null}
                      type="button"
                      variant="custom"
                    >
                      Add as a new post
                    </Button>
                  ) : null}
                  <Button
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      void navigator.clipboard.writeText(turn.content)
                      toast.success('Copied.')
                    }}
                    size={null}
                    type="button"
                    variant="custom"
                  >
                    Copy
                  </Button>
                </p>
              ) : null}
            </li>
          ))}
          {busy ? <li className="text-xs text-muted-foreground">Writing…</li> : null}
        </ol>
      )}
      <form
        className="mt-auto grid gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send(message)
        }}
      >
        <Textarea
          aria-label="Ask the assistant"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(message)
            }
          }}
          placeholder="Ask about this draft…"
          rows={3}
          value={message}
        />
        <span className="flex items-center justify-between text-label text-muted-foreground">
          Uses your workspace’s AI credits.
          <Button disabled={busy || !message.trim()} size="sm" type="submit">
            Send
          </Button>
        </span>
      </form>
    </div>
  )
}

/**
 * Where a set's Writing Assistant is set up: its style guide and samples
 * live in the set's settings (RFC 024), and the assistant and Rewrite follow
 * them.
 */
function AssistantSetup({ onDone, set }: { onDone: () => void; set: WriteSet | null }) {
  const { canManageSets } = useWrite()
  return (
    <div className="grid gap-3 p-4 text-sm" data-testid="assistant-setup">
      <p className="text-foreground">Set up the assistant for {set?.name ?? 'this set'}</p>
      <p className="text-xs text-muted-foreground">
        The assistant and Rewrite write in the brand&rsquo;s voice: its style guide and writing
        samples. Everyone who writes in the set shares it.
      </p>
      {set && canManageSets ? (
        <Button asChild>
          <Link href={socialSetHref(set.id, 'writing-assistant')}>Open the Writing Assistant</Link>
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          An owner or admin sets up the Writing Assistant for a set.
        </p>
      )}
      <Button onClick={onDone} size="sm" type="button" variant="ghost">
        {set?.writingAssistant.status === 'configured' ? 'Back' : 'Skip for now'}
      </Button>
    </div>
  )
}

'use client'

import * as React from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ArrowUpIcon } from '@phosphor-icons/react/dist/ssr/ArrowUp'
import { CopyIcon } from '@phosphor-icons/react/dist/ssr/Copy'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { BookOpenTextIcon } from '@phosphor-icons/react/dist/ssr/BookOpenText'
import { InfoIcon } from '@phosphor-icons/react/dist/ssr/Info'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { socialSetHref } from '@/components/workspace/settings-sections'
import { call } from '@/lib/content-drafts/client'
import { WRITING_PROMPTS } from '@/lib/write/prompt-library'
import { assistPosts } from '@/lib/write/refine-actions'
import { promptBrief, screenshotPrompts } from '@/lib/write/screenshot-post'
import { VoiceMemo } from './voice-memo'
import type { DraftChannel } from '@/lib/write/document'
import { useWrite, type WriteSet } from '../write-context'

/** One turn of the conversation. */
type Turn = { content: string; role: 'assistant' | 'user' }

/** A quiet action under an answer; custom, so the shell's 32px button size does not apply. */
const TURN_ACTION =
  'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground'

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
  hasImage,
  onInsert,
  openWithPrompt,
  posts,
  set,
}: {
  channel: DraftChannel
  draftId: string
  /** The draft carries a screenshot, so the image prompts come first. */
  hasImage?: boolean
  /** Add a reply to the draft as a new post. */
  onInsert?: (text: string) => void
  /** A saved prompt the draft was opened with, waiting to be sent. */
  openWithPrompt?: string
  /** The draft's posts as the platform reads them. */
  posts: string[]
  set: WriteSet | null
}) {
  const [turns, setTurns] = React.useState<Turn[]>([])
  // A draft prepared from an edited screenshot arrives with its chosen
  // prompt and its own text as the notes; the writer still sends it.
  const [message, setMessage] = React.useState(() => {
    const chosen = WRITING_PROMPTS.find((prompt) => prompt.id === openWithPrompt)
    return chosen ? promptBrief(chosen, posts.join('\n\n')) : ''
  })
  const [busy, setBusy] = React.useState(false)
  const [setup, setSetup] = React.useState(false)
  const body = React.useRef<HTMLDivElement>(null)
  // Keep the newest message in view; only the conversation scrolls, never the page.
  React.useEffect(() => {
    if (turns.length && body.current) body.current.scrollTop = body.current.scrollHeight
  }, [turns.length, busy])
  const configured = set?.writingAssistant.status === 'configured'
  // Screenshot posts put the prompts about announcing and explaining first.
  const prompts = hasImage ? screenshotPrompts() : [...WRITING_PROMPTS]
  const usesPrompt = (prompt: (typeof WRITING_PROMPTS)[number]) =>
    setMessage(hasImage ? promptBrief(prompt) : prompt.instruction)
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
  // Help comes first; the brand's voice is offered after a few answers, never as a gate.
  if (setup) return <AssistantSetup onDone={() => setSetup(false)} set={set} />
  const nudge = !configured && Boolean(set) && turns.filter((turn) => turn.role === 'assistant').length >= 3
  return (
    // The conversation scrolls; the message box stays at the panel's foot, as in a chat.
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="assistant-panel">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-6" ref={body}>
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <p className="min-w-0 flex-1">
            Writing in {set?.name ?? 'this set'}’s voice
            {configured ? '' : ' (no style guide yet)'}.{' '}
            <Button
              className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              onClick={() => setSetup(true)}
              size={null}
              type="button"
              variant="custom"
            >
              Style guide and samples
            </Button>
          </p>
          {/* A popover, not a tooltip: the panel is a sheet on phones, where tooltips never open. */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                aria-label="How instructions combine"
                className="grid size-5 shrink-0 place-items-center rounded-md hover:bg-foreground/[0.06] hover:text-foreground"
                size={null}
                type="button"
                variant="custom"
              >
                <InfoIcon aria-hidden className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3 text-xs text-muted-foreground">
              Workspace defaults → Profile overrides → Your instructions for this draft. Prohibited
              terms always apply.
            </PopoverContent>
          </Popover>
        </div>
        <div className="divide-y divide-border rounded-lg border border-border">
          <Disclosure className="px-3 py-2.5">
            <DisclosureTrigger>Writing prompts and examples</DisclosureTrigger>
            <DisclosureContent>
              <p className="my-2 text-xs text-muted-foreground">Examples show a structure. Use your own facts and experience.</p>
              <ul className="grid gap-3">
                {prompts.map((prompt) => (
                  <li key={prompt.id}>
                    <Button type="button" variant="outline" size="sm" onClick={() => usesPrompt(prompt)}>{prompt.title}</Button>
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{prompt.example}</p>
                  </li>
                ))}
              </ul>
            </DisclosureContent>
          </Disclosure>
          <VoiceMemo
            channel={channel}
            draftId={draftId}
            {...(onInsert ? { onInsert } : {})}
            onUse={setMessage}
          />
        </div>
        {nudge ? (
          <p className="rounded-lg bg-foreground/[0.04] px-3 py-2.5 text-xs text-muted-foreground" role="status">
            Add a style guide and writing samples so answers sound like {set?.name ?? 'this profile'}.{' '}
            <Button
              className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
              onClick={() => setSetup(true)}
              size={null}
              type="button"
              variant="custom"
            >
              Set up its voice
            </Button>
          </p>
        ) : null}
        {turns.length === 0 ? (
          <div className="grid gap-1">
            <p className="text-xs font-medium text-muted-foreground">Start with</p>
            <ul aria-label="Suggestions" className="-mx-2 grid">
              {STARTERS.map((starter) => (
                <li key={starter}>
                  <Button
                    className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-ui text-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                    onClick={() => void send(starter)}
                    size={null}
                    type="button"
                    variant="custom"
                  >
                    <span className="min-w-0 flex-1">{starter}</span>
                    <ArrowUpIcon
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                    />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol aria-live="polite" className="grid gap-5">
            {turns.map((turn, index) => (
              <li
                className={
                  turn.role === 'user'
                    ? 'ml-10 justify-self-end rounded-2xl rounded-br-sm bg-foreground/[0.06] px-3 py-2'
                    : 'grid gap-2'
                }
                data-testid={`assistant-${turn.role}`}
                key={index}
              >
                <p className="whitespace-pre-wrap leading-relaxed text-foreground">{turn.content}</p>
                {turn.role === 'assistant' ? (
                  <p className="-ml-2 flex gap-0.5">
                    {onInsert ? (
                      <Button
                        className={TURN_ACTION}
                        // Only the post goes in: never the model's introduction.
                        onClick={() => assistPosts(turn.content).forEach(onInsert)}
                        size={null}
                        type="button"
                        variant="custom"
                      >
                        <PlusIcon aria-hidden className="size-3.5" />
                        Add as a new post
                      </Button>
                    ) : null}
                    <Button
                      className={TURN_ACTION}
                      onClick={() => {
                        void navigator.clipboard.writeText(turn.content)
                        toast.success('Copied.')
                      }}
                      size={null}
                      type="button"
                      variant="custom"
                    >
                      <CopyIcon aria-hidden className="size-3.5" />
                      Copy
                    </Button>
                  </p>
                ) : null}
              </li>
            ))}
            {busy ? (
              <li className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-foreground/40" />
                Writing…
              </li>
            ) : null}
          </ol>
        )}
      </div>
      <form
        className="px-3 pt-2 pb-4"
        onSubmit={(event) => {
          event.preventDefault()
          void send(message)
        }}
      >
        {/* One box: the field drops its own border and ring, and the box takes a quiet focus. */}
        <div className="rounded-xl border border-border transition-colors focus-within:border-foreground/30">
          <Textarea
            aria-label="Ask the assistant"
            className="max-h-48 min-h-0 resize-none border-0! bg-transparent! px-3 pt-2.5 pb-1 shadow-none! focus-visible:ring-0"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send(message)
              }
            }}
            placeholder="Ask about this draft…"
            rows={2}
            value={message}
          />
          <div className="flex items-center gap-1 p-1.5">
            <Select value="" onValueChange={(value) => setMessage(value)}>
              <SelectTrigger
                aria-label="Prompt library"
                className="h-7! w-auto gap-1 rounded-md! border-transparent! bg-transparent! px-2 text-xs! text-muted-foreground hover:bg-foreground/[0.05]! hover:text-foreground"
                size="sm"
              >
                <BookOpenTextIcon aria-hidden className="size-3.5" />
                <SelectValue placeholder="Prompts" />
              </SelectTrigger>
              <SelectContent align="start" className="max-w-80">
                {STARTERS.map((starter) => (
                  <SelectItem key={starter} value={starter}>
                    {starter}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              aria-label="Send"
              className="ml-auto grid size-7 shrink-0 place-items-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/85 disabled:bg-foreground/10 disabled:text-muted-foreground disabled:opacity-100"
              disabled={busy || !message.trim()}
              size={null}
              title="Send (Enter)"
              type="submit"
              variant="custom"
            >
              <ArrowUpIcon aria-hidden className="size-3.5" weight="bold" />
            </Button>
          </div>
        </div>
        <p className="mt-1.5 px-1 text-label text-muted-foreground">Uses your workspace’s AI credits.</p>
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
        The assistant and Rewrite write in the profile&rsquo;s voice: its style guide and writing
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

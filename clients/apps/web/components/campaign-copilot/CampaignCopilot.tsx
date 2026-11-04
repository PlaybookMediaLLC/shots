'use client'

import { SpinnerGapIcon as LoaderCircle } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Pill, type PillTone } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type Client = ReturnType<typeof useTRPCClient>
type ConversationView = Awaited<ReturnType<Client['conversation']['get']['query']>>
type RunView = ConversationView['runs'][number]
type MessageView = ConversationView['messages'][number]
type StepView = RunView['steps'][number]

const POLL_MS = 2_000
/** A retry that has not appended its step by then is given up on. */
const RETRY_WAIT_MS = 25 * 60_000

const RUN_STATUS: Record<RunView['status'], { label: string; tone: PillTone }> = {
  BUDGET_EXHAUSTED: { label: 'Step limit reached', tone: 'yellow' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },
  FAILED: { label: 'Failed', tone: 'red' },
  RUNNING: { label: 'Working', tone: 'blue' },
  SUCCEEDED: { label: 'Done', tone: 'green' },
}

const STEP_STATUS: Record<StepView['status'], { label: string; tone: PillTone }> = {
  DENIED: { label: 'Not allowed', tone: 'yellow' },
  FAILED: { label: 'Failed', tone: 'red' },
  SUCCEEDED: { label: 'Done', tone: 'green' },
}

const isRunning = (view: ConversationView | null) =>
  view?.runs.some((run) => run.status === 'RUNNING') ?? false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function StepRow({
  onRetry,
  retrying,
  step,
}: {
  onRetry: () => void
  retrying: boolean
  step: StepView
}) {
  const status = STEP_STATUS[step.status]
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-foreground">{step.label}</span>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      {step.reason ? <p className="text-xs text-muted-foreground">{step.reason}</p> : null}
      {step.action === 'retry' ? (
        <Button
          className="self-start rounded-lg"
          disabled={retrying}
          onClick={onRetry}
          size="sm"
          type="button"
          variant="outline"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      ) : step.action === 'onboarding' ? (
        <ButtonLink
          className="self-start rounded-lg"
          href="/onboarding/product"
          size="sm"
          variant="outline"
        >
          Add your product
        </ButtonLink>
      ) : step.action === 'ask_admin' ? (
        <p className="text-xs text-foreground/65">Ask an owner, admin, or creator to do this.</p>
      ) : step.action === 'new_turn' ? (
        <p className="text-xs text-foreground/65">Send another message to try a different way.</p>
      ) : null}
    </li>
  )
}

/** One run's trace: its status and every step, failures with their reason and next action. */
function RunTrace({
  onRetry,
  retryingRunId,
  run,
}: {
  onRetry: (stepId: string) => void
  retryingRunId: string | null
  run: RunView | undefined
}) {
  if (!run) return null
  const status = RUN_STATUS[run.status]
  return (
    <section
      aria-label="Agent steps"
      className="rounded-xl bg-foreground/[0.02] px-3 py-2 ring-1 ring-foreground/[0.06]"
    >
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Steps
        </span>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      {run.steps.length === 0 && run.status === 'RUNNING' ? (
        <p className="flex items-center gap-2 py-2 text-sm text-foreground/65">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Thinking it through
        </p>
      ) : null}
      <ol className="divide-y divide-foreground/[0.05]">
        {run.steps.map((step) => (
          <StepRow
            key={step.id}
            onRetry={() => onRetry(step.id)}
            retrying={retryingRunId === run.id}
            step={step}
          />
        ))}
      </ol>
      {run.error && run.status !== 'RUNNING' && run.status !== 'SUCCEEDED' ? (
        <p className="py-1 text-xs text-muted-foreground">{run.error}</p>
      ) : null}
    </section>
  )
}

/** A message as plain text: never markdown, HTML, or auto-linked. */
function MessageBubble({
  message,
  onResend,
}: {
  message: MessageView
  onResend: (() => void) | null
}) {
  const user = message.role === 'user'
  return (
    <div className={cn('flex flex-col gap-1.5', user ? 'items-end' : 'items-start')}>
      {message.kind === 'clarification' ? (
        <span className="text-xs text-muted-foreground">One question</span>
      ) : null}
      <p
        className={cn(
          'max-w-[90%] rounded-xl px-3 py-2 text-sm break-words whitespace-pre-wrap',
          user
            ? 'bg-foreground/[0.08] text-foreground'
            : 'bg-foreground/[0.02] text-foreground ring-1 ring-foreground/[0.06]'
        )}
      >
        {message.content}
      </p>
      {message.action === 'onboarding' ? (
        <ButtonLink className="rounded-lg" href="/onboarding/product" size="sm" variant="outline">
          Add your product
        </ButtonLink>
      ) : message.action === 'resend' && onResend ? (
        <Button className="rounded-lg" onClick={onResend} size="sm" type="button" variant="outline">
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The campaign agent's conversation panel (RFC 028): messages, each run's
 * steps, a composer, and Cancel while a run works. It reads the database
 * through `conversation.get` and polls while a run is RUNNING, so a reload
 * shows the same state. Campaigns it creates open on the campaign pages.
 */
export function CampaignCopilot({
  aiEnabled,
  conversationId,
  onOpenChange,
  open,
}: {
  aiEnabled: boolean
  conversationId: string | null
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [view, setView] = useState<ConversationView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null)
  const viewRef = useRef<ConversationView | null>(null)
  // A retry is done once its run has more steps than when it was asked for.
  const retryRef = useRef<{ runId: string; steps: number; until: number } | null>(null)

  async function load() {
    if (!conversationId) return
    try {
      const next = await client.conversation.get.query({ conversationId })
      const before = viewRef.current
      viewRef.current = next
      setView(next)
      // A finished run may have created or changed the campaign the page shows.
      if (isRunning(before) && !isRunning(next)) router.refresh()
      const retry = retryRef.current
      if (retry) {
        const steps = next.runs.find((run) => run.id === retry.runId)?.steps.length ?? 0
        if (steps > retry.steps || Date.now() > retry.until) {
          retryRef.current = null
          setRetryingRunId(null)
          router.refresh()
        }
      }
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  const poll = useEffectEvent(() => void load())
  const running = isRunning(view)
  useEffect(() => {
    if (open && conversationId) poll()
  }, [open, conversationId])
  useEffect(() => {
    if (!open || !(running || retryingRunId)) return
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [open, running, retryingRunId])

  async function send(content: string) {
    if (!conversationId || !content.trim()) return
    setBusy(true)
    setError(null)
    try {
      await client.conversation.send.mutate({ content: content.trim(), conversationId })
      setDraft('')
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      await load()
      setBusy(false)
    }
  }

  async function cancel(runId: string) {
    try {
      await client.conversation.cancel.mutate({ runId })
    } catch (failure) {
      setError(errorMessage(failure))
    }
    await load()
  }

  async function retry(runId: string, stepId: string) {
    if (!conversationId) return
    setError(null)
    try {
      await client.conversation.retryStep.mutate({ conversationId, runId, stepId })
      const steps = view?.runs.find((run) => run.id === runId)?.steps.length ?? 0
      retryRef.current = { runId, steps, until: Date.now() + RETRY_WAIT_MS }
      setRetryingRunId(runId)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void send(draft)
  }

  const runs = new Map(view?.runs.map((run) => [run.id, run]))
  const activeRun = view?.runs.find((run) => run.status === 'RUNNING') ?? null
  const messages = view?.messages ?? []
  const campaignId = view?.conversation.campaignId ?? null

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-full gap-0 border-foreground/[0.08] bg-background p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-foreground/[0.07] pr-12">
          <SheetTitle className="truncate text-foreground">
            {view?.conversation.title ?? 'Ask Shots'}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Tell Shots what you shipped. The campaign it drafts opens on the campaign pages for you
            to review and approve.
          </SheetDescription>
          {campaignId ? (
            <Link
              className="self-start text-ui-lg font-medium text-foreground underline-offset-4 hover:underline"
              href={`/campaigns/${campaignId}`}
            >
              Open campaign
            </Link>
          ) : null}
        </SheetHeader>
        <div aria-live="polite" className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {view === null && conversationId ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}
          {messages.map((message, index) =>
            message.role === 'tool' ? (
              message.launchRunId ? (
                <RunTrace
                  key={message.id}
                  onRetry={(stepId) => void retry(message.launchRunId!, stepId)}
                  retryingRunId={retryingRunId}
                  run={runs.get(message.launchRunId)}
                />
              ) : null
            ) : (
              <MessageBubble
                key={message.id}
                message={message}
                onResend={
                  message.action === 'resend' && !running
                    ? () => {
                        const previous = messages
                          .slice(0, index)
                          .findLast((entry) => entry.role === 'user')
                        if (previous) void send(previous.content)
                      }
                    : null
                }
              />
            )
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-foreground/[0.07] p-4">
          {error ? (
            <p
              className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {aiEnabled ? (
            <form className="flex flex-col gap-2" onSubmit={submit}>
              <Label className="sr-only" htmlFor="campaign-copilot-message">
                Message
              </Label>
              <Textarea
                className="min-h-20 w-full resize-none rounded-lg bg-foreground/[0.03] px-3 py-2 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none placeholder:text-muted-foreground/75 focus:ring-foreground/20"
                disabled={busy || running}
                id="campaign-copilot-message"
                maxLength={4_000}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void send(draft)
                  }
                }}
                placeholder={running ? 'Shots is working…' : 'What did you ship?'}
                value={draft}
              />
              <div className="flex items-center justify-end gap-2">
                {activeRun ? (
                  <Button
                    className="rounded-lg"
                    onClick={() => void cancel(activeRun.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                ) : null}
                <Button
                  className="rounded-lg"
                  disabled={busy || running || !draft.trim()}
                  size="sm"
                  type="submit"
                >
                  {busy || running ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                  Send
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">AI is turned off for this workspace.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

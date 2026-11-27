'use client'

import dynamic from 'next/dynamic'
import { Fragment, memo, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr/ArrowCounterClockwise'
import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { CopyIcon } from '@phosphor-icons/react/dist/ssr/Copy'
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { toast } from 'sonner'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import type { AssistantEntry } from '@/lib/assistant/ability'
import { safeLinkHref } from '@/lib/assistant/page-context'
import { cn } from '@/lib/utils'
import { AssistantPost } from './AssistantPost'
import { useAssistantStore, useCardState } from './assistant-store'

const AssistantCard = dynamic(() => import('./AssistantCards'), { ssr: false })

/** Render inline **bold**, *italic*, `code`, and safe [label](url) links as React elements. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(
    /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s\n]+\)|\*[^*\n]+\*)/g
  )
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={index} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={index}
          className="rounded bg-foreground/[0.07] px-1 py-0.5 font-mono text-[0.75rem]"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('[') && part.endsWith(')')) {
      const match = part.match(/^\[([^\]\n]+)\]\(([^)\s\n]+)\)$/)
      if (match) {
        const safe = safeLinkHref(match[2]!)
        if (safe) {
          return safe.external ? (
            <a
              key={index}
              href={safe.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            >
              {match[1]}
            </a>
          ) : (
            <SidebarLink
              key={index}
              href={safe.href}
              className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
            >
              {match[1]}
            </SidebarLink>
          )
        }
      }
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={index}>{part.slice(1, -1)}</em>
    }
    return <Fragment key={index}>{part}</Fragment>
  })
}

function CopyButton({
  ariaLabel,
  className,
  errorText,
  text,
  variant = 'ghost',
}: {
  ariaLabel: string
  className: string
  errorText: string
  text: string
  variant?: 'ghost' | 'custom'
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    []
  )

  const copy = () => {
    if (!navigator.clipboard?.writeText) {
      toast.error(errorText)
      return
    }
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          setCopied(false)
        }, 1_500)
      },
      () => toast.error(errorText)
    )
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={variant === 'custom' ? null : 'sm'}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={className}
      onClick={copy}
    >
      {copied ? (
        <>
          <CheckIcon className="size-3" aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <CopyIcon className="size-3" aria-hidden="true" />
          Copy
        </>
      )}
    </Button>
  )
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-foreground/10 bg-background">
      <div className="flex items-center justify-between border-b border-foreground/[0.08] px-2.5 py-1 text-[0.6875rem] text-muted-foreground">
        <span className="font-mono">{lang || 'code'}</span>
        <CopyButton
          ariaLabel="Copy code"
          className="h-5 gap-1 px-1.5 text-[0.6875rem]"
          errorText="Could not copy code."
          text={code}
        />
      </div>
      <pre className="overflow-x-auto p-2.5 font-mono text-[0.75rem] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function renderTextBlocks(segment: string, keyPrefix: string): ReactNode[] {
  const blocks = segment.trim().split(/\n{2,}/)
  return blocks
    .filter((block) => block.trim().length > 0)
    .map((block, blockIndex) => {
      const key = `${keyPrefix}-${blockIndex}`
      const lines = block.split('\n').filter((line) => line.trim().length > 0)
      if (lines.length === 0) return null

      // Heading
      if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0]!)) {
        const heading = lines[0]!.replace(/^#{1,3}\s+/, '')
        return (
          <p key={key} className="font-semibold text-foreground">
            {renderInline(heading)}
          </p>
        )
      }

      // Unordered list
      if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
        return (
          <ul key={key} className="list-disc space-y-1 ps-4">
            {lines.map((line, lineIndex) => (
              <li key={lineIndex}>{renderInline(line.replace(/^\s*[-*•]\s+/, ''))}</li>
            ))}
          </ul>
        )
      }

      // Ordered list
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        return (
          <ol key={key} className="list-decimal space-y-1 ps-4">
            {lines.map((line, lineIndex) => (
              <li key={lineIndex}>{renderInline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>
            ))}
          </ol>
        )
      }

      // Blockquote
      if (lines.every((line) => /^\s*>\s?/.test(line))) {
        return (
          <blockquote
            key={key}
            className="border-s-2 border-foreground/20 ps-2.5 text-muted-foreground"
          >
            {lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line.replace(/^\s*>\s?/, ''))}
              </Fragment>
            ))}
          </blockquote>
        )
      }

      return (
        <p key={key} className="whitespace-pre-wrap">
          {lines.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {renderInline(line)}
            </Fragment>
          ))}
        </p>
      )
    })
}

/** XSS-safe Markdown renderer supporting code blocks, headings, lists, blockquotes, links, bold, italics, and inline code. */
const FormattedReply = memo(function FormattedReply({ text }: { text: string }) {
  const normalized = text.replace(/\r\n/g, '\n')
  const segments = normalized.split(/(```[^\n`]*\n[\s\S]*?```)/g)
  return (
    <div className="space-y-1.5">
      {segments.map((segment, index) => {
        if (segment.startsWith('```') && segment.endsWith('```')) {
          const match = segment.match(/^```([^\n`]*)\n([\s\S]*?)```$/)
          if (match) {
            return (
              <CodeBlock
                key={index}
                lang={(match[1] ?? '').trim()}
                code={match[2]!.replace(/\n$/, '')}
              />
            )
          }
        }
        return <Fragment key={index}>{renderTextBlocks(segment, String(index))}</Fragment>
      })}
    </div>
  )
})

function CopyReplyButton({ text }: { text: string }) {
  return (
    <CopyButton
      ariaLabel="Copy reply"
      className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[0.6875rem] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      errorText="Could not copy reply."
      text={text}
      variant="custom"
    />
  )
}

/** The Undo of the newest change; it refuses once a later edit exists. */
function UndoButton({ stateKey, undo }: { stateKey: string; undo: () => boolean }) {
  const [undone, setUndone] = useCardState(stateKey, false)
  if (undone) return <span>Undone</span>
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 gap-1 rounded-full px-2 text-[0.71875rem] text-muted-foreground hover:text-foreground"
      onClick={() => {
        if (undo()) setUndone(true)
        else toast.message('Newer edits exist. Press ⌘Z to undo them first.')
      }}
    >
      <ArrowCounterClockwiseIcon className="size-3" aria-hidden="true" />
      Undo
    </Button>
  )
}

/** Scroll to bottom only if the reader has not manually scrolled up. */
export function scrollThreadIfPinned(element: HTMLOListElement | null) {
  if (!element) return
  const distance = element.scrollHeight - element.scrollTop - element.clientHeight
  if (distance < 72) element.scrollTo({ top: element.scrollHeight })
}

/** The reply while it streams, or a live tool status until its first words. */
export function AssistantPending({ thread }: { thread: RefObject<HTMLOListElement | null> }) {
  // Subscribed here, so each token redraws this row and not the whole thread.
  const draft = useAssistantStore((state) => state.draft)
  const statusLabel = useAssistantStore((state) => state.statusLabel)
  useEffect(() => {
    scrollThreadIfPinned(thread.current)
  }, [draft, statusLabel, thread])
  return draft ? (
    <li className="max-w-[90%] rounded-2xl bg-foreground/[0.05] px-3 py-2 text-[0.8125rem] leading-relaxed">
      <FormattedReply text={draft} />
    </li>
  ) : (
    <li role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <SpinnerGapIcon className="size-3 animate-spin" aria-hidden="true" />
      <span>{statusLabel || 'Working…'}</span>
    </li>
  )
}

/** Offered draft text, with the writer's decision. */
function ProposalCard({ entry }: { entry: Extract<AssistantEntry, { kind: 'proposal' }> }) {
  const [decision, setDecision] = useCardState<'added' | 'rejected' | null>(
    `${entry.id}:decision`,
    null
  )
  return (
    <div className="w-full space-y-2 rounded-xl border border-foreground/10 bg-background p-2.5">
      <p className="text-xs font-medium text-muted-foreground">{entry.summary}</p>
      <p className="whitespace-pre-wrap">{entry.text}</p>
      {decision ? (
        <p className="text-xs text-muted-foreground">
          {decision === 'added' ? 'Added to the draft' : 'Rejected'}
        </p>
      ) : (
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              if (entry.accept()) setDecision('added')
              else toast.message('The draft changed. Ask again for a new suggestion.')
            }}
          >
            Accept
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setDecision('rejected')}>
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

/** Renders a single entry inside the unified Shots Assistant thread. */
export function AssistantMessage({
  entry,
  canUndo = false,
  onRetry,
  target,
}: {
  entry: AssistantEntry
  /** This is the newest change and nothing is running. */
  canUndo?: boolean
  /** Re-sends a failed prompt when the user clicks Retry. */
  onRetry?: (prompt: string) => void
  /** The part of the surface open now. */
  target?: string
}) {
  const card =
    entry.kind === 'suggestions' ||
    entry.kind === 'variants' ||
    entry.kind === 'captions' ||
    entry.kind === 'redactions' ||
    entry.kind === 'handoff'
      ? entry
      : null

  const activityStatus =
    entry.kind === 'activity' ? (entry.status ?? (entry.done ? 'done' : 'running')) : null

  return (
    <li
      className={cn(
        'text-[0.8125rem] leading-relaxed',
        card || entry.kind === 'post' || entry.kind === 'proposal' ? 'w-full' : 'max-w-[90%]',
        entry.kind === 'user' &&
          'justify-self-end rounded-2xl bg-foreground px-3 py-1.5 text-background',
        entry.kind === 'assistant' && 'group rounded-2xl bg-foreground/[0.05] px-3 py-2',
        entry.kind === 'activity' &&
          'inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-0.5 text-[0.71875rem] text-muted-foreground',
        (entry.kind === 'change' || entry.kind === 'note') && 'text-xs text-muted-foreground',
        entry.kind === 'error' && 'rounded-2xl bg-destructive/10 px-3 py-2 text-destructive'
      )}
    >
      {entry.kind === 'proposal' ? (
        <ProposalCard entry={entry} />
      ) : card ? (
        card.target && card.target !== target ? (
          <p className="text-xs text-muted-foreground">
            Open the artboard this card was made for to use it.
          </p>
        ) : (
          <AssistantCard entry={card} />
        )
      ) : entry.kind === 'link' ? (
        <SidebarLink
          href={entry.href}
          className="inline-flex items-center rounded-full border border-foreground/10 px-3 py-1 text-xs font-medium transition-colors hover:bg-foreground/[0.04]"
        >
          {entry.text} →
        </SidebarLink>
      ) : entry.kind === 'post' ? (
        <AssistantPost text={entry.text} />
      ) : entry.kind === 'activity' ? (
        <>
          {activityStatus === 'running' ? (
            <SpinnerGapIcon className="size-3 shrink-0 animate-spin opacity-75" aria-hidden="true" />
          ) : activityStatus === 'error' ? (
            <WarningCircleIcon className="size-3 shrink-0 text-destructive/80" aria-hidden="true" />
          ) : (
            <CheckIcon className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          )}
          <span>{entry.text}</span>
        </>
      ) : entry.kind === 'change' ? (
        <span className="inline-flex items-center gap-2">
          <span>✓ {entry.text}</span>
          {canUndo && entry.undo ? (
            <UndoButton stateKey={`${entry.id}:undone`} undo={entry.undo} />
          ) : null}
        </span>
      ) : entry.kind === 'error' ? (
        <div className="space-y-1.5">
          <p>{entry.text}</p>
          {entry.retryAsk || entry.actionHref ? (
            <div className="flex flex-wrap items-center gap-2">
              {entry.retryAsk && onRetry ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 rounded-full px-2.5 text-[0.71875rem]"
                  onClick={() => onRetry(entry.retryAsk!)}
                >
                  Retry
                </Button>
              ) : null}
              {entry.actionHref && entry.actionLabel ? (
                <SidebarLink
                  href={entry.actionHref}
                  className="text-xs font-medium underline underline-offset-2"
                >
                  {entry.actionLabel} →
                </SidebarLink>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : entry.kind === 'assistant' ? (
        <div>
          <FormattedReply text={entry.text} />
          <CopyReplyButton text={entry.text} />
        </div>
      ) : 'text' in entry ? (
        entry.text
      ) : null}
    </li>
  )
}

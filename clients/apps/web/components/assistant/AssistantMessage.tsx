'use client'

import dynamic from 'next/dynamic'
import { Fragment, type ReactNode, type RefObject, useEffect } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr/ArrowCounterClockwise'
import { SparkleIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { toast } from 'sonner'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import type { AssistantEntry } from '@/lib/assistant/ability'
import { cn } from '@/lib/utils'
import { AssistantPost } from './AssistantPost'
import { useAssistantStore, useCardState } from './assistant-store'

const AssistantCard = dynamic(() => import('./AssistantCards'), { ssr: false })

/** Render inline **bold** and `code` spans safely as React elements. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)
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
    return <Fragment key={index}>{part}</Fragment>
  })
}

/** Lightweight, XSS-safe Markdown renderer for assistant replies (paragraphs, bullets, bold, code). */
function FormattedReply({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/)
  return (
    <div className="space-y-1.5">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').filter((line) => line.trim().length > 0)
        const isBulletList =
          lines.length > 0 && lines.every((line) => /^\s*[-*•]\s+/.test(line))
        if (isBulletList) {
          return (
            <ul key={blockIndex} className="list-disc space-y-1 ps-4">
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{renderInline(line.replace(/^\s*[-*•]\s+/, ''))}</li>
              ))}
            </ul>
          )
        }
        return (
          <p key={blockIndex} className="whitespace-pre-wrap">
            {lines.map((line, lineIndex) => (
              <Fragment key={lineIndex}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
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

/** The reply while it streams, or a status until its first words. */
export function AssistantPending({ thread }: { thread: RefObject<HTMLOListElement | null> }) {
  // Subscribed here, so each token redraws this row and not the whole thread.
  const draft = useAssistantStore((state) => state.draft)
  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight })
  }, [draft, thread])
  return draft ? (
    <li className="max-w-[90%] rounded-2xl bg-foreground/[0.05] px-3 py-2 text-[0.8125rem] leading-relaxed">
      <FormattedReply text={draft} />
    </li>
  ) : (
    <li role="status" className="text-xs text-muted-foreground">
      Working…
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
  target,
}: {
  entry: AssistantEntry
  /** This is the newest change and nothing is running. */
  canUndo?: boolean
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

  return (
    <li
      className={cn(
        'text-[0.8125rem] leading-relaxed',
        card || entry.kind === 'post' || entry.kind === 'proposal' ? 'w-full' : 'max-w-[90%]',
        entry.kind === 'user' &&
          'justify-self-end rounded-2xl bg-foreground px-3 py-1.5 text-background',
        entry.kind === 'assistant' && 'rounded-2xl bg-foreground/[0.05] px-3 py-2',
        entry.kind === 'activity' &&
          'inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 py-0.5 text-[0.71875rem] text-muted-foreground',
        (entry.kind === 'change' || entry.kind === 'note') && 'text-xs text-muted-foreground',
        entry.kind === 'error' && 'rounded-2xl bg-destructive/10 px-3 py-1.5 text-destructive'
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
          <SparkleIcon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
          <span>{entry.text}</span>
        </>
      ) : entry.kind === 'change' ? (
        <span className="inline-flex items-center gap-2">
          <span>✓ {entry.text}</span>
          {canUndo && entry.undo ? (
            <UndoButton stateKey={`${entry.id}:undone`} undo={entry.undo} />
          ) : null}
        </span>
      ) : entry.kind === 'assistant' ? (
        <FormattedReply text={entry.text} />
      ) : 'text' in entry ? (
        entry.text
      ) : null}
    </li>
  )
}

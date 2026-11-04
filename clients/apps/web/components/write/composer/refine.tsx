'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { postRanges } from '@/components/drafts/thread'
import { call } from '@/lib/content-drafts/client'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import type { DraftChannel } from '@/lib/write/document'
import { REFINE_LABELS, type RefineAction, type RefineScope } from '@/lib/write/refine-actions'
import { cn } from '@/lib/utils'
import { useKeys, useShortcuts } from '../shortcuts'
import { lineDiff } from './share-backups'

/**
 * AI Refine (RFC 025). The writer picks what it works on (the selection,
 * the post at the caret, or every post of this version) and what to do;
 * the answer is previewed beside the original and applied only on Accept,
 * as one change that Undo takes back. If the text changed while the AI was
 * writing, nothing is applied.
 */

/** Blocks that hold a post's words; anything else (images, video, tables) is kept as is. */
const TEXT_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])

/** What was sent, so the answer is applied to the same text or not at all. */
type Request =
  | { kind: 'selection'; original: string; range: NonNullable<PlateEditor['selection']> }
  | { kind: 'posts'; numbers: number[]; originals: string[] }

/** A post's words as the platform reads them. */
function postText(editor: PlateEditor, number: number, channel: DraftChannel): string {
  const [start, end] = postRanges(editor.children)[number - 1] ?? [0, 0]
  const blocks = editor.children
    .slice(start, end)
    .filter((node) => TEXT_BLOCKS.has(String(node.type)))
  return serializeDraft(blocks as Value, channel).caption
}

/** The post the caret is in, 1-based. */
function caretPost(editor: PlateEditor): number {
  const index = editor.selection?.anchor.path[0] ?? 0
  return Math.max(
    1,
    postRanges(editor.children).findIndex(([start, end]) => index >= start && index < end) + 1
  )
}

/** Replace a post's words with text, keeping its break (and id) and its media. */
function replacePost(editor: PlateEditor, number: number, text: string) {
  const [start, end] = postRanges(editor.children)[number - 1]
  const first = editor.children[start]?.type === 'post_break' ? start + 1 : start
  for (let index = end - 1; index >= first; index -= 1) {
    if (TEXT_BLOCKS.has(String(editor.children[index]?.type)))
      editor.tf.removeNodes({ at: [index] })
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => ({ children: [{ text: paragraph }], type: 'p' }))
  editor.tf.insertNodes(paragraphs, { at: [first] })
}

/** How long a text is on the platform. */
function platformLength(text: string, channel: DraftChannel): number {
  return serializeDraft(
    text.split('\n').map((line) => ({ children: [{ text: line }], type: 'p' })),
    channel
  ).length
}

export function RefineButton({
  channel,
  editor,
  limit,
  draftId,
  opener,
}: {
  channel: DraftChannel
  editor: React.MutableRefObject<PlateEditor | null>
  limit: number
  /** The draft, whose set's writing context guides Refine. */
  draftId: string
  /** Set to open Rewrite beside an element, such as a post's sparkle. */
  opener?: React.MutableRefObject<((anchor: HTMLElement) => void) | null>
}) {
  const { mod } = useKeys()
  const [open, setOpen] = React.useState(false)
  const [scope, setScope] = React.useState<RefineScope>('post')
  const [prompt, setPrompt] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // A review keeps what was asked, so Try again asks the same thing.
  const [review, setReview] = React.useState<{
    action: RefineAction
    instruction: string
    request: Request
    texts: string[]
    title: string
  } | null>(null)
  const [hasSelection, setHasSelection] = React.useState(false)
  // Rewrite opens where it was asked for: at a post's sparkle, else at this button.
  const trigger = React.useRef<HTMLButtonElement>(null)
  const anchor = React.useRef<HTMLElement | null>(null)
  const element = () => (anchor.current?.isConnected ? anchor.current : trigger.current)
  // contextElement lets the popover follow its post as the draft scrolls.
  const virtual = React.useRef({
    getBoundingClientRect: () => element()?.getBoundingClientRect() ?? new DOMRect(),
    get contextElement() {
      return element() ?? undefined
    },
  })
  const openMenu = () => {
    const current = editor.current
    const selected = Boolean(current?.selection && !current.api.isCollapsed())
    setHasSelection(selected)
    setScope(selected ? 'selection' : 'post')
    setOpen(true)
  }
  useShortcuts([
    {
      inEditor: true,
      key: 'e',
      label: 'Rewrite',
      mod: true,
      run: () => {
        anchor.current = null
        openMenu()
      },
      shift: true,
    },
  ])
  React.useEffect(() => {
    if (!opener) return
    opener.current = (element) => {
      anchor.current = element
      openMenu()
    }
    return () => {
      opener.current = null
    }
  })
  const run = async (
    action: RefineAction,
    instruction = prompt,
    title = action === 'custom'
      ? 'Your instruction'
      : REFINE_LABELS[action as keyof typeof REFINE_LABELS]
  ) => {
    const current = editor.current
    if (!current) return
    let request: Request
    if (scope === 'selection') {
      if (!current.selection || current.api.isCollapsed()) {
        toast.info('Select some text first, or refine the post.')
        return
      }
      request = {
        kind: 'selection',
        original: current.api.string(current.selection),
        range: current.selection,
      }
    } else {
      const numbers =
        scope === 'post'
          ? [caretPost(current)]
          : postRanges(current.children).map((_, index) => index + 1)
      const originals = numbers.map((number) => postText(current, number, channel))
      const kept = numbers.filter((_, index) => originals[index].trim())
      request = {
        kind: 'posts',
        numbers: kept,
        originals: originals.filter((text) => text.trim()),
      }
    }
    const texts = request.kind === 'selection' ? [request.original] : request.originals
    if (texts.length === 0 || texts.every((text) => !text.trim())) {
      toast.info('Write something first.')
      return
    }
    setBusy(true)
    try {
      const answer = await call<{ texts: string[] }>('/api/v1/content-drafts/refine', {
        body: {
          action,
          channel,
          limit,
          prompt: action === 'custom' ? instruction : undefined,
          draftId,
          scope,
          texts,
        },
        method: 'POST',
      })
      setOpen(false)
      setReview({ action, instruction, request, texts: answer.texts, title })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The AI could not answer.')
    } finally {
      setBusy(false)
    }
  }
  const accept = () => {
    const current = editor.current
    if (!current || !review) return
    const { request, texts } = review
    if (request.kind === 'selection') {
      const now = current.api.string(request.range)
      if (now !== request.original) {
        toast.error(
          'The text changed while the AI was writing. Nothing was applied; refine it again.'
        )
        return
      }
      current.tf.select(request.range)
      current.tf.insertText(texts[0])
    } else {
      const changed = request.numbers.some(
        (number, index) => postText(current, number, channel) !== request.originals[index]
      )
      if (changed) {
        toast.error(
          'The draft changed while the AI was writing. Nothing was applied; refine it again.'
        )
        return
      }
      // One synchronous batch: a single Undo restores every post.
      current.tf.withoutNormalizing(() => {
        for (let index = request.numbers.length - 1; index >= 0; index -= 1) {
          replacePost(current, request.numbers[index], texts[index])
        }
      })
    }
    current.tf.focus()
    setReview(null)
    toast.success(`Applied. Undo (${mod}Z) brings your version back.`)
  }
  return (
    <>
      <Popover
        onOpenChange={(next) => {
          if (next) {
            anchor.current = null
            openMenu()
          } else setOpen(false)
        }}
        open={open}
      >
        <PopoverAnchor virtualRef={virtual} />
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            aria-label="Rewrite"
            className="h-7 rounded-md px-2 text-xs"
            disabled={busy}
            size={null}
            title={`Rewrite (${mod}⇧E)`}
            type="button"
            variant="ghost"
          >
            {busy ? 'Rewriting…' : 'Rewrite'}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="grid w-80 gap-2 p-3"
          data-testid="refine-menu"
          // Focus goes back to what opened it: a post's sparkle, else this button.
          onCloseAutoFocus={(event) => {
            if (!anchor.current?.isConnected) return
            event.preventDefault()
            anchor.current.focus()
          }}
          side="top"
        >
          <fieldset className="flex flex-wrap gap-1 text-xs" aria-label="What to refine">
            {(
              [
                ['selection', 'Selection'],
                ['post', 'This post'],
                ['draft', 'Every post'],
              ] as const
            ).map(([value, label]) => (
              <Button
                aria-pressed={scope === value}
                className={cn(
                  'h-7 px-2 text-xs',
                  scope === value && 'bg-foreground/[0.08] text-foreground'
                )}
                disabled={value === 'selection' && !hasSelection}
                key={value}
                onClick={() => setScope(value)}
                size={null}
                type="button"
                variant="ghost"
              >
                {label}
              </Button>
            ))}
          </fieldset>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              if (prompt.trim()) void run('custom')
            }}
          >
            <Input
              aria-label="Refine instruction"
              className="h-8 text-sm"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Tell the AI what to change…"
              value={prompt}
            />
            <Button disabled={busy || !prompt.trim()} size="sm" type="submit">
              Go
            </Button>
          </form>
          <Button
            className="h-auto justify-start px-2 py-1 text-left text-xs"
            disabled={busy}
            onClick={() =>
              void run(
                'custom',
                `Adapt this for ${CAPABILITIES[channel].label}: keep the facts and the point, and write it the way people post there.`,
                `Adapt for ${CAPABILITIES[channel].label}`
              )
            }
            size={null}
            type="button"
            variant="outline"
          >
            Adapt for {CAPABILITIES[channel].label}
          </Button>
          <div className="grid grid-cols-2 gap-1">
            {(Object.keys(REFINE_LABELS) as (keyof typeof REFINE_LABELS)[])
              .filter((action) => action !== 'custom')
              .map((action) => (
                <Button
                  className="h-auto justify-start whitespace-normal px-2 py-1 text-left text-xs"
                  disabled={busy}
                  key={action}
                  onClick={() => void run(action)}
                  size={null}
                  type="button"
                  variant="ghost"
                >
                  {REFINE_LABELS[action]}
                </Button>
              ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Uses your workspace’s AI credits. You see the result before anything changes.
          </p>
        </PopoverContent>
      </Popover>
      {review ? (
        <Dialog onOpenChange={(next) => !next && setReview(null)} open>
          <DialogContent
            className="max-h-[90dvh] max-w-2xl overflow-y-auto"
            data-testid="refine-review"
          >
            <DialogHeader>
              <DialogTitle>
                {review.title}
              </DialogTitle>
              <DialogDescription>
                Check the AI’s version. Accept replaces the text; Reject leaves it as it is.
              </DialogDescription>
            </DialogHeader>
            <ol className="grid gap-3">
              {review.texts.map((text, index) => {
                const before =
                  review.request.kind === 'selection'
                    ? review.request.original
                    : review.request.originals[index]
                const length = platformLength(text, channel)
                return (
                  <li className="grid gap-1" key={index}>
                    {review.request.kind === 'posts' ? (
                      <p className="text-xs text-muted-foreground">
                        Post {review.request.numbers[index]}
                      </p>
                    ) : null}
                    <pre
                      className="whitespace-pre-wrap rounded-lg bg-foreground/[0.03] p-3 font-sans text-sm"
                      data-testid="refine-diff"
                    >
                      {lineDiff(before, text).map((line, at) => (
                        <span
                          className={cn(
                            'block',
                            line.kind === 'removed' &&
                              'bg-red-500/15 text-red-700 dark:text-red-200 line-through',
                            line.kind === 'added' &&
                              'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
                          )}
                          key={at}
                        >
                          {line.text || ' '}
                        </span>
                      ))}
                    </pre>
                    {review.request.kind === 'posts' ? (
                      <p
                        className={cn(
                          'text-right text-xs',
                          length > limit
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-muted-foreground'
                        )}
                      >
                        {length} / {limit}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ol>
            <DialogFooter>
              <Button onClick={() => setReview(null)} type="button" variant="outline">
                Reject
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  const { action, instruction, title } = review
                  setReview(null)
                  void run(action, instruction, title)
                }}
                type="button"
                variant="ghost"
              >
                Try again
              </Button>
              <Button onClick={accept} type="button">
                Accept
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

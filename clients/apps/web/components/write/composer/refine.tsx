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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import { postRanges } from '@/components/drafts/thread'
import { call } from '@/lib/content-drafts/client'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import type { DraftChannel, PlateBody } from '@/lib/write/document'
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

/**
 * What was sent, so the answer is applied to the same text or not at all.
 * `version` writes another platform's own text, built on `base`.
 */
type Request =
  | { kind: 'selection'; original: string; range: NonNullable<PlateEditor['selection']> }
  | { kind: 'posts'; numbers: number[]; originals: string[] }
  | { kind: 'version'; base: PlateBody; numbers: number[]; originals: string[]; target: DraftChannel }

/** A post's words as the platform reads them. */
function postText(children: Value, number: number, channel: DraftChannel): string {
  const [start, end] = postRanges(children)[number - 1] ?? [0, 0]
  const blocks = children.slice(start, end).filter((node) => TEXT_BLOCKS.has(String(node.type)))
  return serializeDraft(blocks as Value, channel).caption
}

/** The post the caret is in, 1-based. */
export function caretPost(editor: PlateEditor): number {
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

/** A body with post `number`'s words replaced by text, keeping its break and media. */
function withPostText(body: PlateBody, number: number, text: string): PlateBody {
  const [start, end] = postRanges(body as Value)[number - 1]
  const first = body[start]?.type === 'post_break' ? start + 1 : start
  const kept = body.slice(first, end).filter((node) => !TEXT_BLOCKS.has(String(node.type)))
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => ({ children: [{ text: paragraph }], type: 'p' }))
  return [...body.slice(0, first), ...paragraphs, ...kept, ...body.slice(end)] as PlateBody
}

/** How long a text is on the platform. */
function platformLength(text: string, channel: DraftChannel): number {
  return serializeDraft(
    text.split('\n').map((line) => ({ children: [{ text: line }], type: 'p' })),
    channel
  ).length
}


/** One Refine run: what to do, on what, and for which platform's text. */
export type RefineRun = {
  action: RefineAction
  /** The instruction, for `custom`. */
  prompt?: string
  /** Defaults to the selection when there is one, else the post at the caret. */
  scope?: RefineScope
  /** Write this platform's own text from the version open, instead of editing it. */
  target?: DraftChannel
}

/** Refine for the version open: every AI entry point (menus, ⌘J, the slash menu) uses this. */
export type RefineApi = {
  busy: boolean
  /** Open the menu at a trigger: `toolbar`, `selection` or `post-<n>`; ⌘J opens it at the caret's post. */
  open: (at?: string) => void
  run: (request: RefineRun) => void
}

type RefineState = RefineApi & {
  at: string | null
  close: () => void
  hasSelection: boolean
  prompt: string
  register: (at: string) => () => void
  scope: RefineScope
  setPrompt: (prompt: string) => void
  setScope: (scope: RefineScope) => void
}

const RefineContext = React.createContext<RefineState | null>(null)

/** The version open's Refine, or null when AI is off. */
export function useRefine(): RefineApi | null {
  return React.useContext(RefineContext)
}

/**
 * Holds Refine for the composer: one menu (opened at whichever trigger asked),
 * one review, and accept as one change Undo takes back. `onVersion` receives
 * another platform's own text, written from a review the writer accepted.
 */
export function RefineProvider({
  channel,
  children,
  draftId,
  editor,
  limit,
  limitFor,
  onVersion,
  versionBase,
}: {
  channel: DraftChannel
  children: React.ReactNode
  /** The draft, whose set's writing context guides Refine. */
  draftId: string
  editor: React.MutableRefObject<PlateEditor | null>
  limit: number
  limitFor: (channel: DraftChannel) => number
  onVersion: (target: DraftChannel, body: PlateBody) => void
  /** The body another platform's own text starts from. */
  versionBase: (target: DraftChannel) => PlateBody
}) {
  const { mod } = useKeys()
  const [at, setAt] = React.useState<string | null>(null)
  const [scope, setScope] = React.useState<RefineScope>('post')
  const [prompt, setPrompt] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [review, setReview] = React.useState<{
    action: RefineAction
    prompt?: string
    request: Request
    texts: string[]
  } | null>(null)
  const [hasSelection, setHasSelection] = React.useState(false)
  const triggers = React.useRef(new Set<string>())
  const open = (where?: string) => {
    const current = editor.current
    const selected = Boolean(current?.selection && !current.api.isCollapsed())
    const post = current ? `post-${caretPost(current)}` : 'toolbar'
    setHasSelection(selected)
    setScope(selected ? 'selection' : 'post')
    setAt(where ?? (triggers.current.has(post) ? post : 'toolbar'))
  }
  useShortcuts([
    { inEditor: true, key: 'j', label: 'Ask AI', mod: true, run: () => open() },
    { inEditor: true, key: 'e', label: 'Ask AI', mod: true, run: () => open(), shift: true },
  ])
  const run = async ({ action, prompt: instruction, scope: asked, target }: RefineRun) => {
    const current = editor.current
    if (!current) return
    const post = at?.startsWith('post-') ? Number(at.slice(5)) : caretPost(current)
    const selected = Boolean(current.selection && !current.api.isCollapsed())
    const within = asked ?? (at ? scope : selected ? 'selection' : 'post')
    let request: Request
    if (target && target !== channel) {
      const base = versionBase(target)
      const numbers = postRanges(base as Value).map((_, index) => index + 1)
      const originals = numbers.map((number) => postText(base as Value, number, target))
      const kept = numbers.filter((_, index) => originals[index].trim())
      request = { base, kind: 'version', numbers: kept, originals: originals.filter((text) => text.trim()), target }
    } else if (within === 'selection') {
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
        within === 'post' ? [post] : postRanges(current.children).map((_, index) => index + 1)
      const originals = numbers.map((number) => postText(current.children, number, channel))
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
    const writes = request.kind === 'version' ? request.target : channel
    setBusy(true)
    try {
      const answer = await call<{ texts: string[] }>('/api/v1/content-drafts/refine', {
        body: {
          action,
          channel: writes,
          limit: writes === channel ? limit : limitFor(writes),
          prompt: action === 'custom' ? (instruction ?? prompt) : undefined,
          draftId,
          scope: request.kind === 'version' ? 'draft' : within,
          texts,
        },
        method: 'POST',
      })
      setAt(null)
      setReview({ action, prompt: instruction, request, texts: answer.texts })
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
    if (request.kind === 'version') {
      onVersion(
        request.target,
        request.numbers.reduce(
          (body, number, index) => withPostText(body, number, texts[index]),
          request.base
        )
      )
      setReview(null)
      return
    }
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
        (number, index) => postText(current.children, number, channel) !== request.originals[index]
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
  const state: RefineState = {
    at,
    busy,
    close: () => setAt(null),
    hasSelection,
    open,
    prompt,
    register: (where) => {
      triggers.current.add(where)
      return () => triggers.current.delete(where)
    },
    run: (request) => void run(request),
    scope,
    setPrompt,
    setScope,
  }
  const reviewChannel = review?.request.kind === 'version' ? review.request.target : channel
  const reviewLimit = reviewChannel === channel ? limit : limitFor(reviewChannel)
  return (
    <RefineContext.Provider value={state}>
      {children}
      {review ? (
        <Dialog onOpenChange={(next) => !next && setReview(null)} open>
          <DialogContent
            className="max-h-[90dvh] max-w-2xl overflow-y-auto"
            data-testid="refine-review"
          >
            <DialogHeader>
              <DialogTitle>
                {review.action === 'custom'
                  ? (review.prompt ?? 'Your instruction')
                  : REFINE_LABELS[review.action as keyof typeof REFINE_LABELS]}
              </DialogTitle>
              <DialogDescription>
                {review.request.kind === 'version'
                  ? `Check the AI’s version. Accept writes it as ${CHANNEL_META[review.request.target].label}’s own text; Reject leaves everything as it is.`
                  : 'Check the AI’s version. Accept replaces the text; Reject leaves it as it is.'}
              </DialogDescription>
            </DialogHeader>
            <ol className="grid gap-3">
              {review.texts.map((text, index) => {
                const before =
                  review.request.kind === 'selection'
                    ? review.request.original
                    : review.request.originals[index]
                const length = platformLength(text, reviewChannel)
                return (
                  <li className="grid gap-1" key={index}>
                    {review.request.kind !== 'selection' ? (
                      <p className="text-caption text-muted-foreground">
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
                              'bg-destructive/15 text-destructive line-through',
                            line.kind === 'added' &&
                              'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
                          )}
                          key={at}
                        >
                          {line.text || ' '}
                        </span>
                      ))}
                    </pre>
                    {review.request.kind !== 'selection' ? (
                      <p
                        className={cn(
                          'text-right text-caption',
                          length > reviewLimit ? 'text-destructive' : 'text-muted-foreground'
                        )}
                      >
                        {length} / {reviewLimit}
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
                  const { action, prompt: instruction, request } = review
                  setReview(null)
                  void run({
                    action,
                    prompt: instruction,
                    target: request.kind === 'version' ? request.target : undefined,
                  })
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
    </RefineContext.Provider>
  )
}

/**
 * The Refine menu, opened from `children` (a trigger button) at `at`. Pick
 * the scope, write an instruction, or choose a preset; the review follows.
 */
export function RefineMenu({
  align = 'start',
  at,
  children,
  side = 'top',
}: {
  align?: 'start' | 'center' | 'end'
  at: string
  children: React.ReactElement
  side?: 'top' | 'bottom'
}) {
  const refine = React.useContext(RefineContext)
  const register = refine?.register
  React.useEffect(() => register?.(at), [at, register])
  if (!refine) return null
  const { busy, hasSelection, prompt, scope, setPrompt, setScope } = refine
  return (
    <Popover
      onOpenChange={(next) => (next ? refine.open(at) : refine.close())}
      open={refine.at === at}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align={align}
        className="grid w-80 gap-2 p-3"
        data-testid="refine-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
        side={side}
      >
        <fieldset className="flex flex-wrap gap-1" aria-label="What to refine">
          {(
            [
              ['selection', 'Selection'],
              ['post', 'This post'],
              ['draft', 'Every post'],
            ] as const
          ).map(([value, label]) => (
            <Button
              aria-pressed={scope === value}
              className={cn(scope === value && 'bg-accent text-accent-foreground')}
              disabled={value === 'selection' && !hasSelection}
              key={value}
              onClick={() => setScope(value)}
              size="sm"
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
            if (prompt.trim()) refine.run({ action: 'custom', prompt, scope })
          }}
        >
          <Input
            aria-label="Refine instruction"
            autoFocus
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Tell the AI what to change…"
            value={prompt}
          />
          <Button disabled={busy || !prompt.trim()} size="sm" type="submit">
            Go
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-1">
          {(Object.keys(REFINE_LABELS) as (keyof typeof REFINE_LABELS)[])
            .filter((action) => action !== 'custom')
            .map((action) => (
              <Button
                className="h-auto justify-start whitespace-normal py-1.5 text-left"
                disabled={busy}
                key={action}
                onClick={() => refine.run({ action, scope })}
                size="sm"
                type="button"
                variant="ghost"
              >
                {REFINE_LABELS[action]}
              </Button>
            ))}
        </div>
        <p className="text-caption text-muted-foreground">
          {busy
            ? 'Rewriting…'
            : 'Uses your workspace’s AI credits. You see the result before anything changes.'}
        </p>
      </PopoverContent>
    </Popover>
  )
}

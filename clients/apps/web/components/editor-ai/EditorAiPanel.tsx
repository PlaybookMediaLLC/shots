'use client'

import { SparkleIcon as AiMagicIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { ArrowUpIcon as ArrowUp02Icon } from '@phosphor-icons/react/dist/ssr/ArrowUp'
import { XIcon as Cancel01Icon } from '@phosphor-icons/react/dist/ssr/X'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { applyDesignChanges } from '@/lib/design/apply'
import type { DesignChanges } from '@/lib/design/document'
import { describeSelection, exportDesignDocument } from '@/lib/design/export'
import { captureCanvasSnapshot } from '@/lib/design/snapshot'
import { useImageStore } from '@/lib/store'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { CaptionsPanel } from './CaptionsPanel'
import { useEditorCopilot, type VariantsRequest } from './useEditorCopilot'
import { VariantsPanel } from './VariantsPanel'
import { Textarea } from '@/components/ui/textarea'

/**
 * The editor's AI surface: one floating panel with
 *
 * - Copilot: a conversation that edits the live canvas, scoped to the
 *   selected layer when there is one;
 * - Suggestions: up to three one-click improvements from a design review;
 * - Variants: complete versions of the design to compare and apply (the
 *   copilot opens it for "give me four versions");
 * - Captions: alt text and platform captions for the design.
 *
 * Every AI change goes through the editor's own store actions and is one
 * undo step, so ⌘Z always takes it back.
 */

type Status = { backgrounds: boolean; captions: boolean; copilot: boolean; variants: boolean }
type Suggestion = { changes: DesignChanges; reason: string; title: string }
type Tab = 'copilot' | 'variants' | 'captions'
const TAB_LABELS: Record<Tab, string> = {
  captions: 'Captions',
  copilot: 'Copilot',
  variants: 'Variants',
}

const QUICK_PROMPTS = [
  'Make it pop on a dark gradient',
  'Add a short headline above the screenshot',
  'Put it in a laptop mockup',
  'Point an arrow at the main button',
  'Blur any personal details',
  'Make a 9:16 version for stories',
]

export function EditorAiPanel() {
  const aspectRatio = useImageStore((state) => state.selectedAspectRatio)
  const trpcClient = useTRPCClient()
  const [status, setStatus] = useState<Status | null>(null)
  const [open, setOpen] = useState(false)
  // The header belongs to upstream's editor, which only leaves a place for this button.
  const [headerSlot, setHeaderSlot] = useState<Element | null>(null)
  useEffect(() => setHeaderSlot(document.getElementById('editor-header-slot')), [])
  const [tab, setTab] = useState<Tab>('copilot')
  const [input, setInput] = useState('')
  const [selection, setSelection] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [reviewing, setReviewing] = useState(false)
  // At most one automatic review per opening, whatever its outcome.
  const autoReviewed = useRef(false)
  const [variantsRequest, setVariantsRequest] = useState<(VariantsRequest & { id: number }) | null>(
    null
  )
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const showVariants = useCallback((request: VariantsRequest) => {
    setVariantsRequest({ ...request, id: Date.now() })
    setTab('variants')
  }, [])
  const clearVariantsRequest = useCallback(() => setVariantsRequest(null), [])
  const { entries, isRunning, reset, send } = useEditorCopilot(showVariants)
  const hasImage = useImageStore(
    (state) => Boolean(state.uploadedImageUrl) || state.mockups.length > 0
  )

  // Signed-out visitors and unconfigured environments get no AI surface.
  useEffect(() => {
    trpcClient.editorAi.status
      .query()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [trpcClient])

  const openCopilot = useCallback((scoped: boolean) => {
    setSelection(scoped ? (describeSelection()?.label ?? null) : null)
    setTab('copilot')
    setOpen(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [entries])

  const reviewCache = useRef<{ key: string; suggestions: Suggestion[] } | null>(null)
  const review = useCallback(
    async (force = false) => {
      const document = exportDesignDocument()
      const key = JSON.stringify(document)
      if (!force && reviewCache.current?.key === key) {
        setSuggestions(reviewCache.current.suggestions)
        return
      }
      setReviewing(true)
      try {
        const { suggestions: found } = await trpcClient.editorAi.critique.mutate({
          document,
          snapshot: await captureCanvasSnapshot(480),
        })
        reviewCache.current = { key, suggestions: found }
        setSuggestions(found)
      } catch (error) {
        toast.error('Could not review the design', {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setReviewing(false)
      }
    },
    [trpcClient]
  )

  // Review once each time the panel opens on a design, never while editing.
  useEffect(() => {
    if (!open) {
      autoReviewed.current = false
      return
    }
    if (autoReviewed.current || !hasImage || !status?.copilot) return
    autoReviewed.current = true
    void review()
  }, [hasImage, open, review, status?.copilot])

  async function applySuggestion(suggestion: Suggestion) {
    await applyDesignChanges(suggestion.changes, (ref) => ref)
    setSuggestions((current) => current?.filter((item) => item !== suggestion) ?? null)
    toast.success(suggestion.title, { description: 'Applied. Press ⌘Z to undo.' })
  }

  async function handleSend(event?: FormEvent) {
    event?.preventDefault()
    const text = input.trim()
    if (!text) return
    setInput('')
    await send(text, selection)
  }

  if (!status?.copilot) return null

  return (
    <>
      {headerSlot
        ? createPortal(
            <Button
              aria-expanded={open}
              aria-label="Open the AI copilot"
              className="gap-1.5"
              onClick={() => (open ? setOpen(false) : openCopilot(false))}
              size="sm"
              type="button"
              variant="ghost"
            >
              <AiMagicIcon size={16} />
              AI
            </Button>,
            headerSlot
          )
        : null}

      {open ? (
        <section
          aria-label="AI copilot"
          className="fixed bottom-16 right-3 top-[72px] z-40 flex w-[min(380px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
          data-export-exclude
        >
          <header className="flex items-center gap-1 border-b p-2">
            {(['copilot', 'variants', 'captions'] as const).map((value) => (
              <Button
                variant="custom"
                size={null}
                className={cn(
                  'rounded-md px-2.5 py-1 text-ui-lg font-medium',
                  tab === value ? 'bg-muted text-foreground' : 'text-muted-foreground'
                )}
                key={value}
                onClick={() => setTab(value)}
                type="button"
              >
                {TAB_LABELS[value]}
              </Button>
            ))}
            <span className="flex-1" />
            {tab === 'copilot' && entries.length > 0 ? (
              <Button onClick={reset} size="sm" type="button" variant="ghost">
                New chat
              </Button>
            ) : null}
            <Button
              aria-label="Close"
              onClick={() => setOpen(false)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Cancel01Icon size={16} />
            </Button>
          </header>

          {tab === 'copilot' ? (
            <>
              <div className="border-b p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">Suggestions</p>
                  <Button
                    variant="custom"
                    size={null}
                    className="text-xs underline disabled:opacity-50"
                    disabled={reviewing || !hasImage}
                    onClick={() => void review(true)}
                    type="button"
                  >
                    {reviewing ? 'Reviewing…' : 'Review again'}
                  </Button>
                </div>
                {reviewing ? (
                  <p role="status" className="mt-2 text-xs text-muted-foreground">
                    Review runs in the background. You can keep editing.
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {suggestions?.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Looks good. Nothing to fix.</p>
                  ) : null}
                  {suggestions?.map((suggestion) => (
                    <Button
                      variant="custom"
                      size={null}
                      className="rounded-full border px-2.5 py-1 text-left text-xs hover:bg-muted"
                      key={suggestion.title}
                      onClick={() => void applySuggestion(suggestion)}
                      title={suggestion.reason}
                      type="button"
                    >
                      {suggestion.title}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto p-3 text-sm" ref={transcriptRef}>
                {entries.length === 0 ? (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      Tell me what to change. I edit the canvas directly, and every change is one
                      ⌘Z.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {QUICK_PROMPTS.filter(
                        (prompt) => aspectRatio !== '9_16' || !prompt.includes('9:16')
                      ).map((prompt) => (
                        <Button
                          variant="custom"
                          size={null}
                          className="rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
                          disabled={isRunning}
                          key={prompt}
                          onClick={() => void send(prompt, selection)}
                          type="button"
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {entries.map((entry, index) =>
                  entry.kind === 'change' ? (
                    <p className="text-xs text-muted-foreground" key={index}>
                      ✓ {entry.summary}
                    </p>
                  ) : (
                    <p
                      className={cn(
                        'whitespace-pre-wrap rounded-lg px-3 py-2',
                        entry.kind === 'user' && 'ml-8 bg-muted',
                        entry.kind === 'assistant' && 'mr-8 border',
                        entry.kind === 'error' && 'border border-destructive text-destructive'
                      )}
                      key={index}
                    >
                      {entry.text}
                    </p>
                  )
                )}
                {isRunning ? <p className="text-xs text-muted-foreground">Working on it…</p> : null}
              </div>

              <form className="border-t p-2" onSubmit={handleSend}>
                {selection ? (
                  <p className="mb-1.5 flex items-center gap-1 text-xs text-muted-foreground">
                    Editing {selection}
                    <Button
                      variant="custom"
                      size={null}
                      className="underline"
                      onClick={() => setSelection(null)}
                      type="button"
                    >
                      whole design
                    </Button>
                  </p>
                ) : null}
                <div className="flex items-end gap-2">
                  <Textarea
                    aria-label="Ask the copilot"
                    className="max-h-32 min-h-10 flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm"
                    disabled={isRunning}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void handleSend()
                      }
                    }}
                    placeholder="Make the background darker and tilt it slightly"
                    ref={inputRef}
                    rows={1}
                    value={input}
                  />
                  <Button
                    aria-label="Send"
                    disabled={isRunning || !input.trim()}
                    size="icon"
                    type="submit"
                  >
                    <ArrowUp02Icon size={16} />
                  </Button>
                </div>
              </form>
            </>
          ) : tab === 'captions' ? (
            <CaptionsPanel disabled={!hasImage} />
          ) : null}
          <VariantsPanel
            disabled={!hasImage}
            hidden={tab !== 'variants'}
            onRequestHandled={clearVariantsRequest}
            request={variantsRequest}
          />
        </section>
      ) : null}
    </>
  )
}

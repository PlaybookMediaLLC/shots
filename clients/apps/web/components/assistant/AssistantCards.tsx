'use client'

import { useEffect, useState } from 'react'
import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr/ShieldCheck'
import { toast } from 'sonner'
import { CaptionsPanel } from '@/components/editor-ai/CaptionsPanel'
import { VariantsPanel } from '@/components/editor-ai/VariantsPanel'
import { RedactionReviewDialog } from '@/components/editor/redaction/RedactionReviewDialog'
import { Button } from '@/components/ui/button'
import { UseInPostButton } from '@/components/workspace/SaveToWorkspaceButton'
import type { AssistantDesignSuggestion, AssistantEntry } from '@/lib/assistant/ability'
import { applyDesignChanges } from '@/lib/design/apply'
import { withoutImageSources } from '@/lib/design/without-image-sources'
import { useImageStore } from '@/lib/store'
import { useCardState } from './assistant-store'

/** One entry that renders as an editor card. */
export type AssistantCardEntry = Extract<
  AssistantEntry,
  { kind: 'suggestions' | 'variants' | 'captions' | 'redactions' | 'handoff' }
>

/** Inline 1-click design critique suggestions card. */
function SuggestionsCard({ items, stateKey }: { items: AssistantDesignSuggestion[]; stateKey: string }) {
  const [applied, setApplied] = useCardState<number[]>(`${stateKey}:applied`, [])
  const [busy, setBusy] = useState<number | null>(null)

  const applyOne = async (index: number, item: AssistantDesignSuggestion) => {
    if (busy !== null) return
    setBusy(index)
    try {
      await applyDesignChanges(withoutImageSources(item.changes), (ref) => ref)
      setApplied((current) => [...current, index])
      toast.success(`Applied “${item.title}”`, {
        description: 'Press ⌘Z to undo.',
      })
    } catch (error) {
      toast.error('Could not apply suggestion', {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-foreground/10 bg-background p-2.5">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>Design review suggestions</span>
        <span>{items.length}</span>
      </div>
      <div className="space-y-1.5">
        {items.map((item, index) => {
          const isApplied = applied.includes(index)
          return (
            <div
              key={`${item.title}-${index}`}
              className="flex items-start justify-between gap-2.5 rounded-lg border border-foreground/[0.08] bg-foreground/[0.02] p-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-medium text-foreground">{item.title}</p>
                <p className="text-[0.71875rem] leading-snug text-muted-foreground">
                  {item.reason}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={isApplied ? 'ghost' : 'outline'}
                disabled={isApplied || busy !== null}
                className="h-7 shrink-0 px-2.5 text-xs"
                onClick={() => void applyOne(index, item)}
              >
                {isApplied ? (
                  <>
                    <CheckIcon className="me-1 size-3" aria-hidden="true" />
                    Applied
                  </>
                ) : busy === index ? (
                  'Applying…'
                ) : (
                  'Apply'
                )}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Inline Variants workspace card inside the unified assistant thread. */
function VariantsCard({ count, instruction, stateKey }: { count: number; instruction: string; stateKey: string }) {
  const hasImage = useImageStore((state) => Boolean(state.uploadedImageUrl))
  return (
    <div className="w-full overflow-hidden rounded-xl border border-foreground/10 bg-background">
      <div className="border-b border-foreground/[0.08] px-3 py-2 text-xs font-medium">
        Visual variants
      </div>
      <VariantsPanel
        disabled={!hasImage}
        initialCount={count}
        initialInstruction={instruction}
        stateKey={stateKey}
      />
    </div>
  )
}

/** Inline Captions & Alt Text workspace card inside the unified assistant thread. */
function CaptionsCard({ instruction }: { instruction?: string }) {
  const hasImage = useImageStore((state) => Boolean(state.uploadedImageUrl))
  return (
    <div className="w-full overflow-hidden rounded-xl border border-foreground/10 bg-background">
      <div className="border-b border-foreground/[0.08] px-3 py-2 text-xs font-medium">
        Alt text &amp; social captions
      </div>
      <CaptionsPanel disabled={!hasImage} initialNotes={instruction ?? ''} />
    </div>
  )
}

/** Inline on-device PII redaction scanner card opening the full review dialog. */
function RedactionsCard({ autoScan, stateKey }: { autoScan?: boolean; stateKey: string }) {
  const imageUrl = useImageStore((state) => state.uploadedImageUrl)
  // The scan opens by itself once; showing the panel again does not reopen it.
  const [opened, setOpened] = useCardState(`${stateKey}:opened`, false)
  const [open, setOpen] = useState(Boolean(autoScan && imageUrl && !opened))
  const [scanOnOpen, setScanOnOpen] = useState(Boolean(autoScan))
  useEffect(() => {
    if (open) setOpened(true)
  }, [open, setOpened])

  return (
    <div className="w-full space-y-2 rounded-xl border border-foreground/10 bg-background p-3">
      <div className="flex items-start gap-2">
        <ShieldCheckIcon
          className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-foreground">On-device PII redaction</p>
          <p className="text-[0.71875rem] leading-snug text-muted-foreground">
            Scans locally in your browser for emails, keys, cards, names, and faces — nothing is
            uploaded before you apply.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="sm"
          disabled={!imageUrl}
          onClick={() => {
            setScanOnOpen(true)
            setOpen(true)
          }}
        >
          Scan &amp; review
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!imageUrl}
          onClick={() => {
            setScanOnOpen(false)
            setOpen(true)
          }}
        >
          Draw regions manually
        </Button>
      </div>
      {!imageUrl ? (
        <p className="text-[0.71875rem] text-muted-foreground">
          Add a screenshot to the canvas first to scan for sensitive details.
        </p>
      ) : null}
      <RedactionReviewDialog
        imageUrl={imageUrl}
        onOpenChange={setOpen}
        open={open}
        scan={scanOnOpen}
      />
    </div>
  )
}

/**
 * The editor cards of the assistant thread. Loaded only when a card appears,
 * so pages without an editor do not load the editor's code.
 */
export default function AssistantCard({ entry }: { entry: AssistantCardEntry }) {
  const stateKey = String(entry.id)
  switch (entry.kind) {
    case 'suggestions':
      return <SuggestionsCard items={entry.items} stateKey={stateKey} />
    case 'variants':
      return <VariantsCard count={entry.count} instruction={entry.instruction} stateKey={stateKey} />
    case 'captions':
      return <CaptionsCard instruction={entry.instruction} />
    case 'handoff':
      return (
        <div className="flex flex-wrap gap-2 rounded-xl border border-foreground/10 bg-background p-3">
          <UseInPostButton label="Use in a post" variant="outline" />
        </div>
      )
    case 'redactions':
      return <RedactionsCard autoScan={entry.autoScan} stateKey={stateKey} />
  }
}

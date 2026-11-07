'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '@/components/design/DocumentPreview'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DesignChanges, DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { patchFromModel } from '@/lib/design/model-changes'
import { applyStoredDocument } from '@/lib/design/open-design'
import { rememberUploadedSources } from '@/lib/design/upload-sources'
import { UseInPostButton } from '@/components/workspace/SaveToWorkspaceButton'
import { usePostHandoff } from '@/lib/editor/post-handoff'
import { useCanStartPost } from '@/lib/platform/can-start-post'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { type VariantsRequest, withoutImageSources } from './useEditorCopilot'
import { Textarea } from '@/components/ui/textarea'

/** A version: its changes, and a preview of them on the design as it was when it was made. */
type Candidate = { changes: DesignChanges; preview: DesignDocument; reason: string; title: string }

const COUNTS = [2, 3, 4, 6] as const
const LARGE = { format: 'jpeg', maxWidth: 1200, quality: 'high' } as const

/**
 * Complete versions of the design, side by side with the original. Nothing
 * changes until the user applies one; applying is one undo step, and the
 * versions stay here to compare or switch to another.
 *
 * The versions are also offered to the post dialog, so one screenshot can
 * become a post per version to review side by side.
 */
export function VariantsPanel({
  disabled,
  hidden,
  onRequestHandled,
  request,
}: {
  disabled: boolean
  /** Hidden rather than unmounted, so the versions survive switching tabs. */
  hidden: boolean
  onRequestHandled: () => void
  request: (VariantsRequest & { id: number }) | null
}) {
  const trpcClient = useTRPCClient()
  const canStartPost = useCanStartPost()
  const [estimate, setEstimate] = useState<{ lower: number; upper: number } | null>(null)
  const [estimateError, setEstimateError] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [count, setCount] = useState(4)
  const [loading, setLoading] = useState(false)
  const [original, setOriginal] = useState<DesignDocument | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [inspecting, setInspecting] = useState<Candidate | null>(null)

  useEffect(() => {
    if (hidden || disabled) return
    let active = true
    setEstimate(null)
    setEstimateError(false)
    trpcClient.editorAi.variantEstimate.query({ count, document: exportDesignDocument() }).then(
      (value) => { if (active) setEstimate(value) },
      () => { if (active) setEstimateError(true) }
    )
    return () => { active = false }
  }, [count, disabled, hidden, trpcClient])

  const generate = useCallback(
    async (wanted: number, words: string) => {
      setLoading(true)
      try {
        // The model sees the design without local images; each version is
        // built on the full design here, so it keeps the user's screenshot.
        const base = exportDesignDocument({ keepLocalSources: true })
        const view = exportDesignDocument()
        const { variants } = await trpcClient.editorAi.variants.mutate({
          count: wanted,
          document: view,
          instruction: words.trim() || undefined,
        })
        const built = variants.flatMap((variant) => {
          const changes = withoutImageSources(variant.changes)
          try {
            return [
              {
                changes,
                preview: patchFromModel(base, view, changes),
                reason: variant.reason,
                title: variant.title,
              },
            ]
          } catch {
            return []
          }
        })
        setOriginal(base)
        setCandidates(built)
        if (built.length === 0) toast.error('No versions came back. Try again.')
        else if (built.length < wanted)
          toast.message(`${built.length} of ${wanted} versions came back.`)
      } catch (error) {
        toast.error('Could not make versions', {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setLoading(false)
      }
    },
    [trpcClient]
  )

  // The post dialog renders each version as it is previewed here, so what
  // is compared side by side is exactly what each post attaches. Versions
  // that are no longer on screen are no longer on offer.
  useEffect(() => {
    usePostHandoff.getState().setVersions(
      candidates.map((candidate) => ({ document: candidate.preview, title: candidate.title }))
    )
  }, [candidates])
  useEffect(() => () => usePostHandoff.getState().setVersions([]), [])

  // The copilot's "give me four versions" arrives here.
  // Handled once: the request is cleared, so a remount never runs it again.
  useEffect(() => {
    if (!request) return
    onRequestHandled()
    setCount(request.count)
    setInstruction(request.instruction)
    setCandidates([])
  }, [generate, onRequestHandled, request])

  async function apply(candidate: Candidate) {
    try {
      // Applied to the design as it is now, so edits since the versions were made are kept.
      const document = patchFromModel(
        exportDesignDocument({ keepLocalSources: true }),
        exportDesignDocument(),
        candidate.changes
      )
      rememberUploadedSources(await applyStoredDocument(trpcClient, document, 'step'))
      setInspecting(null)
      toast.success(`Applied “${candidate.title}”`, {
        description: 'Press ⌘Z to go back to the original.',
      })
    } catch (error) {
      toast.error('Could not apply that version', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-3 text-sm" hidden={hidden}>
      <p className="text-muted-foreground">
        Complete versions of this design to compare. Your design does not change until you apply
        one.
      </p>
      <Textarea
        aria-label="What the versions should explore"
        className="w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm"
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="Optional: e.g. bolder, for LinkedIn, try device mockups"
        rows={2}
        value={instruction}
      />
      <div className="flex items-center gap-2">
        <div
          aria-label="How many versions"
          className="flex rounded-md border p-0.5"
          role="radiogroup"
        >
          {COUNTS.map((value) => (
            <Button variant="custom" size={null}
              aria-checked={count === value}
              className={cn(
                'rounded px-2 py-1 text-xs',
                count === value ? 'bg-muted font-medium' : 'text-muted-foreground'
              )}
              key={value}
              onClick={() => setCount(value)}
              role="radio"
              type="button"
            >
              {value}
            </Button>
          ))}
        </div>
        <Button
          className="flex-1"
          disabled={disabled || loading || !estimate}
          onClick={() => void generate(count, instruction)}
          type="button"
        >
          {loading ? 'Making versions…' : `Make ${count} versions`}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">{estimate ? `Estimated ${estimate.lower}–${estimate.upper} AI credits for ${count} versions.` : estimateError ? 'Estimate unavailable. Retry by selecting a version count.' : 'Estimating AI credits…'} Charged for actual usage; complex designs and retries can exceed the estimate.</p>
      {disabled ? (
        <p className="text-xs text-muted-foreground">Add a screenshot to the canvas first.</p>
      ) : null}
      {candidates.length > 0 && original ? (
        <ul aria-label="Versions" className="grid grid-cols-2 gap-2">
          <li>
            <figure className="overflow-hidden rounded-lg border border-dashed">
              <div className="aspect-[4/3] bg-muted/40">
                <DocumentPreview alt="Original design" document={original} />
              </div>
              <figcaption className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                Original
              </figcaption>
            </figure>
          </li>
          {candidates.map((candidate) => (
            <li key={candidate.title}>
              <Button variant="custom" size={null}
                aria-label={`Inspect ${candidate.title}`}
                className="w-full overflow-hidden rounded-lg border text-left hover:ring-2 hover:ring-ring"
                onClick={() => setInspecting(candidate)}
                title={candidate.reason}
                type="button"
              >
                <div className="aspect-[4/3] bg-muted/40">
                  <DocumentPreview alt={candidate.title} document={candidate.preview} />
                </div>
                <span className="block truncate px-2 py-1.5 text-xs font-medium">
                  {candidate.title}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {candidates.length > 0 && canStartPost ? (
        <UseInPostButton
          disabled={disabled}
          label={`Post the ${candidates.length} versions`}
          startWithVersions
          variant="outline"
        />
      ) : null}

      <Dialog onOpenChange={(open) => !open && setInspecting(null)} open={inspecting !== null}>
        <DialogContent className="bg-background sm:max-w-[880px]">
          <DialogHeader>
            <DialogTitle>{inspecting?.title}</DialogTitle>
            <DialogDescription>{inspecting?.reason}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <figure>
              <div className="aspect-[4/3] rounded-md bg-muted/40">
                <DocumentPreview alt="Original design" document={original} output={LARGE} />
              </div>
              <figcaption className="mt-1 text-xs text-muted-foreground">Original</figcaption>
            </figure>
            <figure>
              <div className="aspect-[4/3] rounded-md bg-muted/40">
                <DocumentPreview
                  alt={inspecting?.title ?? 'Version'}
                  document={inspecting?.preview ?? null}
                  output={LARGE}
                />
              </div>
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {inspecting?.title}
              </figcaption>
            </figure>
          </div>
          <DialogFooter>
            <Button onClick={() => setInspecting(null)} type="button" variant="outline">
              Keep original
            </Button>
            <Button onClick={() => inspecting && void apply(inspecting)} type="button">
              Apply this version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

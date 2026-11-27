'use client'

import { MagicWandIcon as MagicWand01Icon } from '@phosphor-icons/react/dist/ssr/MagicWand'
import { useRouter } from 'next/navigation'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { RevisionProposal } from '@/lib/launch/spec-schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { DiffView } from './DiffView'
import { waitForLaunchRun } from './run-polling'
import { changeFields } from './proposal-text'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'

export type RevisionTarget =
  | { planId: string; type: 'plan' }
  | { postId: string; type: 'post' }
  | { designId: string; type: 'design' }
  | { section: string; specId: string; type: 'spec_section' }

type Proposed = { id: string; proposal: RevisionProposal }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/**
 * "Revise with AI": a reviewer says what to change, the AI proposes it, and
 * the reviewer sees word diffs (including consistency updates for related
 * pieces) and applies or discards. Nothing changes until applied.
 */
export function RevisePanel({
  campaignId,
  className,
  disabled,
  placeholder = 'For example: lead with the time saved',
  target,
  triggerLabel = 'Revise with AI',
}: {
  campaignId: string
  className?: string
  disabled?: boolean
  placeholder?: string
  target: RevisionTarget
  triggerLabel?: string
}) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState<'apply' | 'discard' | 'propose' | null>(null)
  const [proposed, setProposed] = useState<Proposed | null>(null)
  const [related, setRelated] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Set while the proposal's run is going, so it can be cancelled.
  const [runId, setRunId] = useState<string | null>(null)

  async function propose() {
    setBusy('propose')
    setError(null)
    try {
      const { run } = await trpcClient.launch.revision.propose.mutate({
        campaignId,
        comment,
        target: target as Parameters<typeof trpcClient.launch.revision.propose.mutate>[0]['target'],
      })
      setRunId(run.id)
      const finished = await waitForLaunchRun(trpcClient, run.id)
      if (finished.status !== 'SUCCEEDED' || !finished.resultId) {
        throw new Error(finished.error ?? 'The revision could not be drafted.')
      }
      const { revision } = await trpcClient.launch.revision.get.query({
        revisionId: finished.resultId,
      })
      setProposed({ id: revision.id, proposal: revision.proposal })
      setRelated(new Set(revision.proposal.related.map((_change, index) => index)))
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setRunId(null)
      setBusy(null)
    }
  }

  async function cancelRun(id: string) {
    try {
      await trpcClient.launch.cancelRun.mutate({ runId: id })
    } catch (requestError) {
      setError(errorMessage(requestError))
    }
  }

  async function decide(kind: 'apply' | 'discard') {
    if (!proposed) return
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'apply') {
        const result = await trpcClient.launch.revision.accept.mutate({
          related: [...related],
          revisionId: proposed.id,
        })
        toast.success('Revision applied', {
          description: result.renderingInBackground
            ? 'Re-rendering updated designs in the background.'
            : result.rendered
              ? 'The design was rendered again.'
              : undefined,
        })
      } else {
        await trpcClient.launch.revision.discard.mutate({ revisionId: proposed.id })
      }
      setProposed(null)
      setComment('')
      setOpen(false)
      router.refresh()
    } catch (requestError) {
      setError(errorMessage(requestError))
    } finally {
      setBusy(null)
    }
  }

  if (!open) {
    return (
      <Button
        className={cn('h-8 gap-1.5 rounded-lg text-xs', className)}
        disabled={disabled}
        onClick={() => setOpen(true)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <MagicWand01Icon size={14} />
        {triggerLabel}
      </Button>
    )
  }

  return (
    <div
      className={cn(
        'space-y-3 rounded-xl bg-foreground/[0.02] p-3 ring-1 ring-foreground/[0.08]',
        className
      )}
    >
      {proposed ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground">{proposed.proposal.summary}</p>
          <div className="space-y-2">
            {changeFields(proposed.proposal.primary).map((field) => (
              <DiffView
                after={field.after}
                before={field.before}
                key={field.label}
                label={field.label}
              />
            ))}
          </div>
          {proposed.proposal.related.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-foreground/65">
                Keep related pieces consistent ({proposed.proposal.related.length})
              </p>
              {proposed.proposal.related.map((change, index) => (
                <Label
                  className="block space-y-2 rounded-lg p-2 ring-1 ring-foreground/[0.06]"
                  key={`${change.targetId}-${index}`}
                >
                  <span className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={related.has(index)}
                      className="mt-1 size-4 accent-white"
                      onCheckedChange={(checked) => {
                        const next = new Set(related)
                        if (checked === true) next.add(index)
                        else next.delete(index)
                        setRelated(next)
                      }}
                    />
                    <span>
                      <span className="font-medium text-foreground">{change.label}</span>
                      <span className="block text-xs text-muted-foreground">{change.reason}</span>
                    </span>
                  </span>
                  {changeFields(change).map((field) => (
                    <DiffView
                      after={field.after}
                      before={field.before}
                      key={field.label}
                      label={field.label}
                    />
                  ))}
                </Label>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              className="rounded-lg"
              disabled={busy !== null}
              onClick={() => void decide('discard')}
              size="sm"
              type="button"
              variant="ghost"
            >
              {busy === 'discard' ? 'Discarding…' : 'Discard'}
            </Button>
            <Button
              className="rounded-lg"
              disabled={busy !== null}
              onClick={() => void decide('apply')}
              size="sm"
              type="button"
            >
              {busy === 'apply' ? 'Applying…' : 'Apply changes'}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void propose()
          }}
        >
          <Label className="block text-xs font-medium text-foreground/65" htmlFor={fieldId}>
            What should change?
          </Label>
          <Textarea
            autoFocus
            className="min-h-20 w-full rounded-lg border border-foreground/[0.08] bg-foreground/[0.03] px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/75 focus:border-foreground/20"
            id={fieldId}
            maxLength={1_000}
            minLength={3}
            onChange={(event) => setComment(event.target.value)}
            placeholder={placeholder}
            required
            value={comment}
          />
          <div className="flex justify-end gap-2">
            <Button
              className="rounded-lg"
              disabled={busy !== null && !runId}
              onClick={() => (runId ? void cancelRun(runId) : setOpen(false))}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="rounded-lg"
              disabled={busy !== null || comment.trim().length < 3}
              size="sm"
              type="submit"
            >
              {busy === 'propose' ? 'Proposing…' : 'Propose changes'}
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p
          className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

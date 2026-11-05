'use client'

import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import type { CaptureJob, CaptureRecipe } from '@/lib/api/contracts/capture'
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import { CAPTURE_JOB_PHASE, captureJobOpen } from '@/lib/workflows/capture'
import { CaptureError, useCaptureAction } from './capture-ui'
import { relativeTime } from './workflow-ui'

const KIND: Record<CaptureJob['kind'], string> = {
  deployment: 'After a deployment',
  manual: 'Requested',
  test: 'Test',
}

function JobRow({
  canManage,
  job,
  onChanged,
  recipe,
}: {
  canManage: boolean
  job: CaptureJob
  onChanged: () => Promise<void>
  recipe?: CaptureRecipe
}) {
  const client = useTRPCClient()
  const { busy, error, run } = useCaptureAction()
  const phase = CAPTURE_JOB_PHASE[job.phase]
  const cancel = () =>
    run(async () => {
      await client.capture.cancelJob.mutate({ id: job.id })
      await onChanged()
    })
  return (
    <Row>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-lg text-foreground">
              {recipe?.name ?? 'Recipe'} · version {job.recipeVersion}
            </h3>
            <Pill tone={phase.tone}>{phase.label}</Pill>
          </div>
          <p className="text-xs text-muted-foreground">
            {KIND[job.kind]} · {relativeTime(job.createdAt)}
          </p>
          {job.failureCode ? (
            <p className="text-sm text-muted-foreground">
              {captureFailureMessage(job.failureCode)}
            </p>
          ) : null}
          <CaptureError message={error} />
        </div>
        {canManage && captureJobOpen(job.phase) ? (
          <Button
            disabled={busy}
            onClick={() => void cancel()}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? 'Cancelling…' : 'Cancel'}
          </Button>
        ) : null}
      </div>
    </Row>
  )
}

/** Recent capture jobs; the backend returns the 50 newest. */
export function CaptureJobs({
  canManage,
  jobs,
  onChanged,
  recipes,
}: {
  canManage: boolean
  jobs: CaptureJob[]
  onChanged: () => Promise<void>
  recipes: CaptureRecipe[]
}) {
  return (
    <Section title="Recent captures">
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been captured yet.</p>
      ) : (
        <Group>
          {jobs.map((job) => (
            <JobRow
              canManage={canManage}
              job={job}
              key={job.id}
              onChanged={onChanged}
              recipe={recipes.find((recipe) => recipe.id === job.recipeId)}
            />
          ))}
        </Group>
      )}
    </Section>
  )
}

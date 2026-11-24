'use client'

import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import type { CaptureJob, CaptureRecipe } from '@/lib/api/contracts/capture'
import { editorHref } from '@/lib/platform/editor-handoff'
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  CAPTURE_JOB_PHASE,
  captureJobOpen,
  captureNavigationSummary,
} from '@/lib/workflows/capture'
import { CaptureError, useCaptureAction } from './capture-ui'
import { relativeTime } from './workflow-ui'

const KIND: Record<CaptureJob['kind'], string> = {
  agent: 'From a workflow',
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
  const navigation = captureNavigationSummary(job)
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
          {job.releaseChange ? (
            <p className="text-sm text-muted-foreground">Steered to show: {job.releaseChange}</p>
          ) : null}
          {navigation ? <p className="text-sm text-muted-foreground">{navigation}</p> : null}
          {job.assetId ? (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <a
                aria-label={`Open capture of ${recipe?.name ?? 'screen'} at full size`}
                className="block w-40 overflow-hidden rounded-lg ring-1 ring-foreground/[0.08] focus-visible:ring-2"
                href={`/api/v1/assets/${encodeURIComponent(job.assetId)}/content`}
                rel="noopener noreferrer"
                target="_blank"
              >
                <img
                  alt={`Capture of ${recipe?.name ?? 'screen'}`}
                  className="aspect-[16/10] w-full object-cover object-top"
                  loading="lazy"
                  src={`/api/v1/assets/${encodeURIComponent(job.assetId)}/content?variant=thumbnail`}
                />
              </a>
              <ButtonLink href={editorHref({ assetId: job.assetId })} size="sm" variant="outline">
                Open in editor
              </ButtonLink>
            </div>
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

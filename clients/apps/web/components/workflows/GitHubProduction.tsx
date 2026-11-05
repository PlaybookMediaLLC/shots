'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import {
  githubProductionStateSchema,
  githubPolicyVersionSchema,
  githubProductionCatalogSchema,
  githubProductionDecisionSchema,
  githubRecoverySchema,
  type GitHubProductionPolicy,
} from 'screenshot-studio-backend-sdk'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { requestJson, getErrorMessage } from '@/components/workspace/settings-client'
import { useTRPC } from '@/lib/trpc/react'

const lines = (value: string) => value.split('\n')
const trimmed = (values: string[]) => values.map((v) => v.trim()).filter(Boolean)
/** Preview and save submit the same policy: trimmed lines, no blank entries. */
const normalized = (policy: GitHubProductionPolicy): GitHubProductionPolicy => ({
  ...policy,
  environments: trimmed(policy.environments),
  refs: trimmed(policy.refs),
  jobNames: trimmed(policy.jobNames),
})
type Decision = z.infer<typeof githubProductionDecisionSchema>
/** The checks whose backend names would not mean anything on their own. */
const CHECK_NAMES: Record<string, string> = {
  change_receipt: 'proof of change',
  installation: 'GitHub account',
  receipt_reporter: 'who reported the change',
}

function DecisionDetails({ decision }: { decision: Decision }) {
  return (
    <div className="space-y-2" aria-live="polite">
      <p>
        <strong>{decision.status.replaceAll('_', ' ')}</strong> — {decision.reason}
      </p>
      {decision.strength ? (
        <p className="text-sm text-muted-foreground">
          Proof: {decision.strength.replaceAll('_', ' ')}
        </p>
      ) : null}
      <ul className="space-y-1 text-sm">
        {decision.checks.map((check, index) => (
          <li key={`${check.condition}:${index}`}>
            <strong>
              {CHECK_NAMES[check.condition] ?? check.condition.replaceAll('_', ' ')}
            </strong>
            : {check.status.replaceAll('_', ' ')} — {check.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A repository's production policy, a preview on past events, and recovery of missed ones. */
export function GitHubProduction({
  sourceId,
  canManage,
}: {
  sourceId: string
  canManage: boolean
}) {
  const base = `/api/v1/github/sources/${encodeURIComponent(sourceId)}`
  const trpc = useTRPC()
  const overview = useQuery(trpc.releaseAutomation.overview.queryOptions())
  const [cursor, setCursor] = useState('')
  const state = useQuery({
    queryKey: ['github-production', sourceId, cursor],
    queryFn: () =>
      requestJson(
        `${base}/production?cursor=${encodeURIComponent(cursor)}`,
        githubProductionStateSchema
      ),
  })
  const [runId, setRunId] = useState('')
  const [attempt, setAttempt] = useState('1')
  const [jobQuery, setJobQuery] = useState('')
  const catalog = useQuery({
    queryKey: ['github-production-catalog', sourceId, jobQuery],
    queryFn: () =>
      requestJson(`${base}/production-catalog${jobQuery}`, githubProductionCatalogSchema),
  })
  const recovery = useQuery({
    queryKey: ['github-recovery', sourceId],
    queryFn: () => requestJson(`${base}/delivery-recovery`, githubRecoverySchema),
  })
  const [appIdsText, setAppIdsText] = useState<string | null>(null)
  // A draft keeps the revision it was started from, so a concurrent save is a conflict.
  const [draft, setDraft] = useState<{
    revision: number
    policy: GitHubProductionPolicy
  } | null>(null)
  const [preview, setPreview] = useState<Decision | null>(null)
  const [observationId, setObservationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const latest = state.data?.policies[0]
  const revision = draft?.revision ?? latest?.revision ?? 0
  const policy: GitHubProductionPolicy =
    draft?.policy ??
    (latest?.policy.schemaVersion === 1
      ? latest.policy
      : {
          schemaVersion: 1,
          enabled: false,
          installationId: catalog.data?.installationId ?? 0,
          repositoryId: catalog.data?.repositoryId ?? '',
          environments: ['production'],
          refs: [],
          signal: 'deployment_status',
          workflows: [],
          jobNames: [],
          trustedAppIds: [],
          requireChangeReceipt: true,
          trustActionsOutcome: false,
          definitionId: '',
        })
  const change = (patch: Partial<GitHubProductionPolicy>) => {
    setDraft({ revision, policy: { ...policy, ...patch } })
    setPreview(null)
    setMessage('')
  }
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await operation()
    } catch (cause) {
      setError(getErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const source = overview.data?.sources.find((item) => item.id === sourceId)
  const definitions =
    overview.data?.definitions.filter(
      (item) =>
        item.sourceAppId === sourceId &&
        item.draft.family === 'deployment.succeeded' &&
        !item.archived
    ) ?? []
  const selectedObservation = state.data?.observations.find((item) => item.id === observationId)
  const failure =
    error ||
    (state.error ? getErrorMessage(state.error) : '') ||
    (catalog.error ? getErrorMessage(catalog.error) : '') ||
    (recovery.error ? getErrorMessage(recovery.error) : '')
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8">
      <ButtonLink href="/workflows/sources" variant="outline">
        Back to repositories
      </ButtonLink>
      <div>
        <h2 className="text-xl font-semibold">{source?.name ?? 'Watched repository'}</h2>
        <p className="text-sm text-muted-foreground">
          GitHub access: {catalog.data?.access.replaceAll('_', ' ') ?? 'checking'}
        </p>
      </div>
      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <section className="space-y-3 rounded-lg border p-5" aria-label="GitHub access">
        <h2 className="text-lg font-semibold">What Shots can read from GitHub</h2>
        <p>{catalog.data?.reason}</p>
        <p>
          Deployments: {catalog.data?.capabilities?.deployments ? 'can read' : 'cannot read yet'}.
          Actions: {catalog.data?.capabilities?.actions ? 'can read' : 'cannot read yet'}.
        </p>
        <p>
          Events GitHub sends:{' '}
          {catalog.data?.capabilities?.subscriptionsKnown
            ? catalog.data.capabilities.events.join(', ') || 'none'
            : 'unknown'}
          .
        </p>
        <p className="text-sm text-muted-foreground">
          If an event is missing, ask whoever owns the Shots GitHub App to turn on
          deployment_status, workflow_run or workflow_job. An owner of the GitHub account may need
          to approve Actions access. Releases and pull requests keep arriving in the meantime.
        </p>
        <Button variant="outline" onClick={() => void catalog.refetch()}>
          Refresh access
        </Button>
      </section>
      <section className="space-y-4 rounded-lg border p-5" aria-label="Production policy">
        <h2 className="text-lg font-semibold">What counts as production</h2>
        {latest?.policy.schemaVersion === 0 ? (
          <p className="text-amber-700">
            This repository still uses the older rule, which goes by a deployment&apos;s production
            flag or environment name. Saving a policy replaces it for new events. Past events and
            queued runs do not change.
          </p>
        ) : null}
        {latest && latest.revision !== revision ? (
          <Alert>
            <AlertDescription>
              <p>
                This policy changed to revision {latest.revision} after you started editing revision{' '}
                {revision}. Saving your changes is refused so they cannot overwrite it. Reload the
                latest revision to continue; your unsaved changes will be discarded.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDraft(null)
                  setAppIdsText(null)
                  setPreview(null)
                  setError('')
                  setMessage(`Loaded revision ${latest.revision}.`)
                }}
              >
                Reload latest revision
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {!latest ? (
          <p>
            This repository has no policy yet. Shots keeps its events for review until you turn one
            on.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {latest ? `Revision ${latest.revision}. ` : ''}A match starts the workflow you choose. It
          does not approve anything for customers, or prove the new version is live. Events that
          arrive more than 15 minutes late are kept for review.
        </p>
        <fieldset disabled={!canManage || busy} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="production-signal">What proves a production deployment</Label>
            <Select
              value={policy.signal}
              onValueChange={(value) =>
                change({
                  signal: value,
                  trustActionsOutcome: false,
                  requireChangeReceipt: value === 'deployment_status',
                })
              }
            >
              <SelectTrigger
                id="production-signal"
                className="w-full rounded-md border bg-background p-2"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deployment_status">
                  A successful deployment reported to GitHub
                </SelectItem>
                <SelectItem value="workflow_run">A GitHub Actions workflow you trust</SelectItem>
                <SelectItem value="workflow_job">A GitHub Actions job you trust</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="production-environments">
                Production environment names (one per line)
              </Label>
              <Textarea
                id="production-environments"
                value={policy.environments.join('\n')}
                onChange={(event) => change({ environments: lines(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="production-refs">
                Branches or tags allowed (one exact name per line; empty allows any)
              </Label>
              <Textarea
                id="production-refs"
                value={policy.refs.join('\n')}
                onChange={(event) => change({ refs: lines(event.target.value) })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="production-apps">GitHub App IDs allowed to report deployments</Label>
            <Input
              id="production-apps"
              value={appIdsText ?? policy.trustedAppIds.join(', ')}
              placeholder="Needed to prove what changed"
              onChange={(event) => {
                setAppIdsText(event.target.value)
                change({
                  trustedAppIds: event.target.value
                    .split(/[,\s]+/)
                    .filter(Boolean)
                    .map(Number),
                })
              }}
            />
          </div>
          {policy.signal === 'deployment_status' ? (
            <Label htmlFor="production-change-receipt" className="items-start leading-normal">
              <Checkbox
                id="production-change-receipt"
                checked={policy.requireChangeReceipt}
                onCheckedChange={(checked) => change({ requireChangeReceipt: checked === true })}
              />
              <span>
                Require proof that this commit changed production. Without it, a success may mean
                nothing changed. Your deploy tool must report the task shots-deploy-v1 with a
                version 1 payload containing changed and revision.
              </span>
            </Label>
          ) : (
            <Label htmlFor="production-trust-actions" className="items-start leading-normal">
              <Checkbox
                id="production-trust-actions"
                checked={policy.trustActionsOutcome}
                onCheckedChange={(checked) => change({ trustActionsOutcome: checked === true })}
              />
              <span>
                I trust this GitHub Actions result as proof of a production deployment. A success
                can be a build that changed nothing, so this does not prove a new version went live.
              </span>
            </Label>
          )}
          <div className="space-y-2">
            <h3 className="font-medium">GitHub Actions workflows</h3>
            <p className="text-sm text-muted-foreground">
              Choose the ones that deploy to production. If one is renamed, moved, disabled or
              deleted, Shots asks you to review it. Leave these empty if your deployments do not
              rely on Actions.
            </p>
            {catalog.data?.workflows.map((workflow) => (
              <Label
                htmlFor={`production-workflow-${workflow.id}`}
                className="items-start leading-normal"
                key={workflow.id}
              >
                <Checkbox
                  id={`production-workflow-${workflow.id}`}
                  checked={policy.workflows.some((item) => item.id === workflow.id)}
                  onCheckedChange={(checked) =>
                    change({
                      workflows:
                        checked === true
                          ? [...policy.workflows, workflow]
                          : policy.workflows.filter((item) => item.id !== workflow.id),
                    })
                  }
                />
                <span>
                  {workflow.name} · #{workflow.id} · {workflow.path} · {workflow.state}
                </span>
              </Label>
            ))}
            {policy.workflows
              .filter(
                (selected) => !catalog.data?.workflows.some((item) => item.id === selected.id)
              )
              .map((selected) => (
                <p key={selected.id} className="text-amber-700">
                  Shots can no longer find {selected.name} #{selected.id} ({selected.path}). Refresh
                  access or choose a replacement.{' '}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      change({
                        workflows: policy.workflows.filter((item) => item.id !== selected.id),
                      })
                    }
                  >
                    Remove selection
                  </Button>
                </p>
              ))}
          </div>
          <div className="space-y-2">
            <Label htmlFor="production-jobs">Deployment job names (one exact name per line)</Label>
            <Textarea
              id="production-jobs"
              value={policy.jobNames.join('\n')}
              onChange={(event) => change({ jobNames: lines(event.target.value) })}
            />
            <p className="text-sm text-muted-foreground">
              GitHub gives a job a new ID on each rerun, so the rule goes by its exact name in the
              workflow you chose. If GitHub does not link an event to a job, it needs your
              attention.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <Label htmlFor="job-run">GitHub run ID</Label>
              <Input
                id="job-run"
                value={runId}
                onChange={(event) => setRunId(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="job-attempt">Attempt</Label>
              <Input
                id="job-attempt"
                value={attempt}
                onChange={(event) => setAttempt(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              disabled={!runId || !attempt}
              onClick={() =>
                setJobQuery(
                  `?runId=${encodeURIComponent(runId)}&attempt=${encodeURIComponent(attempt)}`
                )
              }
            >
              Load jobs for this attempt
            </Button>
          </div>
          {catalog.data?.jobs.map((job) => (
            <div key={job.id} className="flex flex-wrap items-center gap-2">
              <span>
                {job.name} · {job.conclusion || job.status}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  change({ jobNames: Array.from(new Set([...policy.jobNames, job.name])) })
                }
              >
                Watch this job name
              </Button>
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="shots-workflow">Shots workflow to run</Label>
            <Select
              value={policy.definitionId}
              onValueChange={(value) => change({ definitionId: value })}
            >
              <SelectTrigger
                id="shots-workflow"
                className="w-full rounded-md border bg-background p-2"
              >
                <SelectValue placeholder="Select a deployment workflow" />
              </SelectTrigger>
              <SelectContent>
                {definitions.map((definition) => (
                  <SelectItem key={definition.id} value={definition.id}>
                    {definition.name} · {definition.enabled ? 'active' : 'not active'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              The workflow that runs on a match. Activate it in the editor before you turn this
              policy on. Each run keeps the version that was active when the event arrived.
            </p>
          </div>
          <Label htmlFor="production-enabled">
            <Checkbox
              id="production-enabled"
              checked={policy.enabled}
              onCheckedChange={(checked) => change({ enabled: checked === true })}
            />
            Turn on for new events
          </Label>
          <Button
            onClick={() =>
              void perform(async () => {
                await requestJson(`${base}/production`, githubPolicyVersionSchema, {
                  method: 'PUT',
                  body: { expectedRevision: revision, policy: normalized(policy) },
                }).catch(async (cause: unknown) => {
                  // A refused save shows the newer revision and the reload action.
                  await state.refetch()
                  throw cause
                })
                setDraft(null)
                setPreview(null)
                await state.refetch()
                setMessage('Policy saved. Past events were not run again.')
              })
            }
          >
            Save policy
          </Button>
        </fieldset>
        {!canManage ? <p>Owners and administrators can change this policy.</p> : null}
      </section>
      <section className="space-y-4 rounded-lg border p-5" aria-label="Past events and preview">
        <h2 className="text-lg font-semibold">Past events</h2>
        <p>
          See how this policy treats an event GitHub already sent. Nothing runs, nothing is saved,
          and no credits are spent. A value GitHub did not send stays unknown.
        </p>
        <Label htmlFor="production-observation">Past event</Label>
        <Select
          value={observationId}
          onValueChange={(value) => {
            setObservationId(value)
            setPreview(null)
          }}
        >
          <SelectTrigger
            id="production-observation"
            className="w-full rounded-md border bg-background p-2"
          >
            <SelectValue placeholder="Select an event" />
          </SelectTrigger>
          <SelectContent>
            {state.data?.observations.map((observation) => (
              <SelectItem key={observation.id} value={observation.id}>
                {observation.evidence.eventName} · {observation.evidence.objectId} ·{' '}
                {observation.evidence.state} · {observation.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={busy || !observationId || !policy.definitionId}
          onClick={() =>
            void perform(async () => {
              setPreview(
                await requestJson(`${base}/production-preview`, githubProductionDecisionSchema, {
                  method: 'POST',
                  body: { policy: normalized(policy), observationId },
                })
              )
            })
          }
        >
          Preview this policy
        </Button>
        {preview ? <DecisionDetails decision={preview} /> : null}
        {selectedObservation ? (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">What Shots decided at the time</h3>
            <DecisionDetails decision={selectedObservation.decision} />
            <dl className="grid gap-2 break-all text-sm md:grid-cols-2">
              <div>
                <dt>Delivery</dt>
                <dd>{selectedObservation.deliveryId}</dd>
              </div>
              <div>
                <dt>GitHub object / event</dt>
                <dd>
                  {selectedObservation.evidence.objectKey} /{' '}
                  {selectedObservation.evidence.observationId}
                </dd>
              </div>
              <div>
                <dt>Occurred / received</dt>
                <dd>
                  {selectedObservation.evidence.occurredAt} / {selectedObservation.receivedAt}
                </dd>
              </div>
              <div>
                <dt>Processed / how it arrived / duplicates</dt>
                <dd>
                  {selectedObservation.processedAt ?? 'Pending'} / {selectedObservation.origin} /{' '}
                  {selectedObservation.duplicates}
                </dd>
              </div>
              <div>
                <dt>Policy / workflow version</dt>
                <dd>
                  {selectedObservation.policyId ?? 'No policy'} /{' '}
                  {selectedObservation.workflowVersionId ?? 'None'}
                </dd>
              </div>
              <div>
                <dt>What it started</dt>
                <dd>
                  {selectedObservation.eventId ?? 'Nothing'}{' '}
                  {selectedObservation.runId ? (
                    <ButtonLink href={`/workflows/runs/${selectedObservation.runId}`}>
                      View workflow run
                    </ButtonLink>
                  ) : null}{' '}
                  {selectedObservation.dispatchStatus}
                </dd>
              </div>
            </dl>
            <Disclosure>
              <DisclosureTrigger>What GitHub sent</DisclosureTrigger>
              <DisclosureContent>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(selectedObservation.evidence, null, 2)}
                </pre>
              </DisclosureContent>
            </Disclosure>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void state.refetch()}>
            Refresh events
          </Button>
          {cursor ? (
            <Button
              variant="outline"
              onClick={() => {
                setCursor('')
                setObservationId('')
              }}
            >
              Newest events
            </Button>
          ) : null}
          {state.data?.nextCursor ? (
            <Button
              variant="outline"
              onClick={() => {
                setCursor(state.data?.nextCursor ?? '')
                setObservationId('')
              }}
            >
              Older events
            </Button>
          ) : null}
        </div>
        <Disclosure>
          <DisclosureTrigger>Policy revision history</DisclosureTrigger>
          <DisclosureContent>
            {state.data?.policies.map((version) => (
              <Disclosure key={version.id} className="my-2">
                <DisclosureTrigger>
                  Revision {version.revision} · {version.id} · {version.createdAt}
                </DisclosureTrigger>
                <DisclosureContent>
                  <pre className="overflow-auto whitespace-pre-wrap text-xs">
                    {JSON.stringify(version.policy, null, 2)}
                  </pre>
                </DisclosureContent>
              </Disclosure>
            ))}
          </DisclosureContent>
        </Disclosure>
      </section>
      <section className="space-y-3 rounded-lg border p-5" aria-label="Missed events">
        <h2 className="text-lg font-semibold">Missed events</h2>
        <p>
          <strong>{recovery.data?.status.replaceAll('_', ' ') ?? 'Loading'}</strong> —{' '}
          {recovery.data?.reason}
        </p>
        <p>
          GitHub&apos;s history starts: {recovery.data?.windowStart ?? 'unknown'}. Last checked:{' '}
          {recovery.data?.lastCompleteAt ?? 'never'}.
        </p>
        <p>
          {recovery.data?.gap === false
            ? 'Nothing is missing from what GitHub still has. Events it never sent stay unknown.'
            : 'Events may be missing. Compare GitHub deployments and releases with whoever owns the repository.'}
        </p>
        <p className="text-sm text-muted-foreground">
          GitHub keeps its delivery history for three days and does not retry failures by itself.
          Recovered events are kept for review and do not start workflows. Asking GitHub to resend
          an event does not prove it arrived.
        </p>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await requestJson(`${base}/delivery-recovery`, githubRecoverySchema, {
                    method: 'POST',
                    body: { redeliver: false },
                  })
                  await recovery.refetch()
                })
              }
            >
              {recovery.data?.hasMore ? 'Check the next page' : 'Check for missed events'}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await requestJson(`${base}/delivery-recovery`, githubRecoverySchema, {
                    method: 'POST',
                    body: { redeliver: true },
                  })
                  await recovery.refetch()
                })
              }
            >
              Recover missed events for review
            </Button>
          </div>
        ) : null}
        {recovery.data?.nextAttemptAt ? (
          <p className="text-sm">Next check or retry after {recovery.data.nextAttemptAt}.</p>
        ) : null}
        <ul className="space-y-2 text-sm">
          {recovery.data?.deliveries.map((delivery) => (
            <li key={delivery.id}>
              {delivery.eventName} · {delivery.guid} · {delivery.status} · attempts{' '}
              {delivery.attempts}/3
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

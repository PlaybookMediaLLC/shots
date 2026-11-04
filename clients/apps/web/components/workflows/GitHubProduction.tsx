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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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

function DecisionDetails({ decision }: { decision: Decision }) {
  return (
    <div className="space-y-2" aria-live="polite">
      <p>
        <strong>{decision.status.replaceAll('_', ' ')}</strong> — {decision.reason}
      </p>
      {decision.strength ? (
        <p className="text-sm text-muted-foreground">
          Evidence: {decision.strength.replaceAll('_', ' ')}
        </p>
      ) : null}
      <ul className="space-y-1 text-sm">
        {decision.checks.map((check, index) => (
          <li key={`${check.condition}:${index}`}>
            <strong>{check.condition}</strong>: {check.status.replaceAll('_', ' ')} — {check.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Repository policy, read-only preview and provider recovery share the backend authority. */
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
      <ButtonLink href="/workflows?view=sources" variant="outline">
        Back to event sources
      </ButtonLink>
      <div>
        <h2 className="text-xl font-semibold">{source?.name ?? 'Connected repository'}</h2>
        <p className="text-sm text-muted-foreground">
          Installation {catalog.data?.installationId || 'unknown'} · repository{' '}
          {catalog.data?.repositoryId || 'unknown'} · {catalog.data?.access ?? 'Checking access'}
        </p>
      </div>
      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <section className="space-y-3 rounded-lg border p-5" aria-label="GitHub access">
        <h2 className="text-lg font-semibold">Access and subscriptions</h2>
        <p>{catalog.data?.reason}</p>
        <p>
          Deployments read:{' '}
          {catalog.data?.capabilities?.deployments ? 'available' : 'missing or unknown'}. Actions
          read: {catalog.data?.capabilities?.actions ? 'available' : 'missing or unknown'}.
        </p>
        <p>
          Subscriptions:{' '}
          {catalog.data?.capabilities?.subscriptionsKnown
            ? catalog.data.capabilities.events.join(', ') || 'none'
            : 'unknown'}
          .
        </p>
        <p className="text-sm text-muted-foreground">
          The GitHub App owner must enable deployment_status, workflow_run and workflow_job as
          needed. Installation owners may need to approve Actions read. Existing release and PR
          ingestion continues while approval is pending.
        </p>
        <Button variant="outline" onClick={() => void catalog.refetch()}>
          Refresh access
        </Button>
      </section>
      <section className="space-y-4 rounded-lg border p-5" aria-label="Production policy">
        <h2 className="text-lg font-semibold">Repository production policy</h2>
        {latest?.policy.schemaVersion === 0 ? (
          <p className="text-amber-700">
            This repository retains the legacy production flag-or-name rule. Saving a new policy
            explicitly replaces it for future observations; history and queued runs stay pinned.
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
            New repositories require an explicit policy. Observations are retained for review until
            you enable one.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Policy schema 1 · current revision {latest?.revision ?? 0}. Qualification is evidence for
          a release, not approval, proof of a live revision, or general availability. Events first
          received more than 15 minutes after occurrence are kept for review.
        </p>
        <fieldset disabled={!canManage || busy} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="production-signal">Evidence required</Label>
            <NativeSelect
              id="production-signal"
              className="w-full rounded-md border bg-background p-2"
              value={policy.signal}
              onChange={(event) =>
                change({
                  signal: event.target.value,
                  trustActionsOutcome: false,
                  requireChangeReceipt: event.target.value === 'deployment_status',
                })
              }
            >
              <NativeSelectOption value="deployment_status">
                Successful reported deployment
              </NativeSelectOption>
              <NativeSelectOption value="workflow_run">
                Explicitly trusted workflow outcome
              </NativeSelectOption>
              <NativeSelectOption value="workflow_job">
                Explicitly trusted job outcome
              </NativeSelectOption>
            </NativeSelect>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="production-environments">
                Production environment names and aliases (one per line)
              </Label>
              <Textarea
                id="production-environments"
                value={policy.environments.join('\n')}
                onChange={(event) => change({ environments: lines(event.target.value) })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="production-refs">
                Allowed refs (one exact provider value per line; empty allows any)
              </Label>
              <Textarea
                id="production-refs"
                value={policy.refs.join('\n')}
                onChange={(event) => change({ refs: lines(event.target.value) })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="production-apps">Trusted reporting GitHub App IDs</Label>
            <Input
              id="production-apps"
              value={appIdsText ?? policy.trustedAppIds.join(', ')}
              placeholder="Required for a change receipt"
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
                Require a trusted deployment-change receipt for this SHA. Without it, a reported
                success may be a no-op. The reporter must use task shots-deploy-v1 and a version 1
                payload with changed and revision.
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
                I explicitly trust this selected Actions outcome as production evidence for one
                configured environment. A success can be a build or no-op; this policy does not
                prove a new deployment change.
              </span>
            </Label>
          )}
          <div className="space-y-2">
            <h3 className="font-medium">GitHub Actions workflows</h3>
            <p className="text-sm text-muted-foreground">
              Select stable workflow IDs. A renamed, moved, deleted, disabled or inaccessible
              selection requires review. Leave empty when deployment evidence has no Actions
              requirement.
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
                  Unavailable selection: {selected.name} #{selected.id} ({selected.path}). Refresh
                  access or explicitly select a replacement.{' '}
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
            <Label htmlFor="production-jobs">
              Deployment job names (one exact display name per line)
            </Label>
            <Textarea
              id="production-jobs"
              value={policy.jobNames.join('\n')}
              onChange={(event) => change({ jobNames: lines(event.target.value) })}
            />
            <p className="text-sm text-muted-foreground">
              GitHub job instance IDs change on reruns. The rule uses an exact job name within the
              selected stable workflow; missing provider correlation needs attention.
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
                {job.name} · instance #{job.id} · {job.conclusion || job.status}
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
            <NativeSelect
              id="shots-workflow"
              className="w-full rounded-md border bg-background p-2"
              value={policy.definitionId}
              onChange={(event) => change({ definitionId: event.target.value })}
            >
              <NativeSelectOption value="">Select a deployment workflow</NativeSelectOption>
              {definitions.map((definition) => (
                <NativeSelectOption key={definition.id} value={definition.id}>
                  {definition.name} · {definition.enabled ? 'active' : 'inactive'} · version{' '}
                  {definition.activeVersionId ?? 'none'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-sm text-muted-foreground">
              This is the Shots release-automation graph. Its active version is pinned when an event
              arrives. Activate it in the workflow editor before enabling this policy.
            </p>
          </div>
          <Label htmlFor="production-enabled">
            <Checkbox
              id="production-enabled"
              checked={policy.enabled}
              onCheckedChange={(checked) => change({ enabled: checked === true })}
            />
            Enable for new live events
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
                setMessage('Policy revision saved. Historical events were not replayed.')
              })
            }
          >
            Save policy revision
          </Button>
        </fieldset>
        {!canManage ? <p>Owners and administrators can change this policy.</p> : null}
      </section>
      <section className="space-y-4 rounded-lg border p-5" aria-label="Evidence and preview">
        <h2 className="text-lg font-semibold">Evidence and read-only preview</h2>
        <p>
          Preview uses recorded evidence and performs no enrichment, writes, workflow execution or
          paid generation. A missing value remains unknown.
        </p>
        <Label htmlFor="production-observation">Recorded observation</Label>
        <NativeSelect
          id="production-observation"
          className="w-full rounded-md border bg-background p-2"
          value={observationId}
          onChange={(event) => {
            setObservationId(event.target.value)
            setPreview(null)
          }}
        >
          <NativeSelectOption value="">Select an event</NativeSelectOption>
          {state.data?.observations.map((observation) => (
            <NativeSelectOption key={observation.id} value={observation.id}>
              {observation.evidence.eventName} · {observation.evidence.objectId} ·{' '}
              {observation.evidence.state} · {observation.status}
            </NativeSelectOption>
          ))}
        </NativeSelect>
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
          Preview current policy
        </Button>
        {preview ? <DecisionDetails decision={preview} /> : null}
        {selectedObservation ? (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">Recorded decision</h3>
            <DecisionDetails decision={selectedObservation.decision} />
            <dl className="grid gap-2 break-all text-sm md:grid-cols-2">
              <div>
                <dt>Delivery</dt>
                <dd>{selectedObservation.deliveryId}</dd>
              </div>
              <div>
                <dt>Source object / observation</dt>
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
                <dt>Processing / origin / duplicates</dt>
                <dd>
                  {selectedObservation.processedAt ?? 'Pending'} / {selectedObservation.origin} /{' '}
                  {selectedObservation.duplicates}
                </dd>
              </div>
              <div>
                <dt>Policy / Shots workflow version</dt>
                <dd>
                  {selectedObservation.policyId ?? 'Unconfigured'} /{' '}
                  {selectedObservation.workflowVersionId ?? 'None'}
                </dd>
              </div>
              <div>
                <dt>Resulting Shots event</dt>
                <dd>
                  {selectedObservation.eventId ?? 'No event created'}{' '}
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
              <DisclosureTrigger>Provider evidence</DisclosureTrigger>
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
      <section className="space-y-3 rounded-lg border p-5" aria-label="Delivery recovery">
        <h2 className="text-lg font-semibold">Delivery recovery and history gaps</h2>
        <p>
          <strong>{recovery.data?.status ?? 'Loading'}</strong> — {recovery.data?.reason}
        </p>
        <p>
          Available window begins: {recovery.data?.windowStart ?? 'Unknown'}. Last completed
          inspection: {recovery.data?.lastCompleteAt ?? 'Never'}.
        </p>
        <p>
          History gap:{' '}
          {recovery.data?.gap === false
            ? 'No gap found in the inspected delivery window; events never sent remain unknown.'
            : 'Yes or unknown. Review GitHub deployments and releases with the repository owner.'}
        </p>
        <p className="text-sm text-muted-foreground">
          GitHub.com retains delivery history for three days and does not automatically retry
          failures. Recovery imports evidence for review only, without live automation. A successful
          redelivery request is not proof of receipt.
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
              {recovery.data?.hasMore ? 'Inspect next page' : 'Inspect delivery history'}
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
              Recover failed deliveries for review
            </Button>
          </div>
        ) : null}
        {recovery.data?.nextAttemptAt ? (
          <p className="text-sm">Next inspection or retry after {recovery.data.nextAttemptAt}.</p>
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

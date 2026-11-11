'use client'

import { Background, Controls, ReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { editorHref, type EditorReturn } from '@/lib/platform/editor-handoff'
import { runHandler } from '@/lib/workflows/history'
import { Suspense, use, useCallback, useEffect, useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Page, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table'
import { getErrorMessage } from '@/components/workspace/settings-client'
import type {
  AutomationOverview,
  AutomationRunDetail,
} from '@/lib/api/contracts/release-automation'
import type { AutomationVersion } from '@/lib/api/contracts/workflow-runs'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  conditionSummary,
  canvasEdges,
  canvasNodes,
  FAMILY_NAMES,
  nodeLabel,
  workflowNodeTypes,
} from './workflow-canvas'
import { duration, FAILURE_CODES, RunStatusPill, runActive, triggeringObject } from './workflow-ui'

type Review = { status: string; posts: { status: string }[] }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-sm text-foreground">{children}</dd>
    </div>
  )
}

/** One persisted run: its evidence, pinned version, path, receipts, and outputs. */
export function WorkflowRunDetail({
  brandKit,
  canManage,
  id,
}: {
  /** The workspace's active brand kit for the run's capture; null when it could not be read. */
  brandKit: Promise<{ kitId: string | null } | null>
  canManage: boolean
  id: string
}) {
  const client = useTRPCClient()
  const params = useSearchParams()
  const returnTo = params.get('returnTo') ?? ''
  const historyHref = /^\/(?:[a-z]{2}\/)?workflows\/runs(?:\?|$)/.test(returnTo)
    ? returnTo
    : '/workflows/runs'
  const [detail, setDetail] = useState<AutomationRunDetail | null>(null)
  const [version, setVersion] = useState<AutomationVersion | null>(null)
  const [overview, setOverview] = useState<AutomationOverview | null>(null)
  const [review, setReview] = useState<Review | 'unavailable' | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [run, next] = await Promise.all([
        client.releaseAutomation.run.query({ id }),
        client.releaseAutomation.overview.query(),
      ])
      setDetail(run)
      setOverview(next)
      if (run.run.versionId)
        setVersion(await client.releaseAutomation.version.query({ id: run.run.versionId }))
      if (run.run.outputs.campaignId) {
        setReview(
          await client.campaign.get
            .query({ campaignId: run.run.outputs.campaignId })
            .then((result): Review => result.campaign)
            .catch(() => 'unavailable' as const)
        )
      }
    } catch (failure) {
      setError(getErrorMessage(failure))
    }
  }, [client, id])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!detail || !runActive(detail.run.status)) return
    const timer = setInterval(() => void load(), 4_000)
    return () => clearInterval(timer)
  }, [detail, load])

  if (!detail) {
    return (
      <Page title="Workflow run">
        <p
          className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          role={error ? 'alert' : 'status'}
        >
          {error ?? 'Loading run…'}
        </p>
      </Page>
    )
  }

  const { event, run, nodes: receipts } = detail
  const definition = overview?.definitions.find((candidate) => candidate.id === run.definitionId)
  const path = receipts.map((receipt) => receipt.nodeId)
  const failed = new Set(
    receipts
      .filter((receipt) => receipt.status !== 'completed' && receipt.status !== 'running')
      .map((receipt) => receipt.nodeId)
  )
  const graph = version?.graph
  const node = graph?.nodes.find((candidate) => candidate.id === selected)
  const receipt = receipts.find((candidate) => candidate.nodeId === selected)
  const fields = { ...event.snapshot.fields, ...event.enrichment }
  const canCancel =
    ['queued', 'running', 'failed', 'needs_attention'].includes(run.status) && !run.cancelRequested
  const canRetry =
    run.status === 'failed' && run.failureCode === 'activity_failed' && !run.cancelRequested

  function recover(kind: 'cancel' | 'retry') {
    setBusy(true)
    setError(null)
    void client.releaseAutomation[kind]
      .mutate({ id: run.id })
      .then(load)
      .catch((failure) => setError(getErrorMessage(failure)))
      .finally(() => setBusy(false))
  }

  return (
    <Page
      actions={
        <>
          <ButtonLink href={historyHref} variant="outline">
            Back to runs
          </ButtonLink>
          {canManage && canCancel ? (
            <Button disabled={busy} onClick={() => recover('cancel')} variant="outline">
              Cancel run
            </Button>
          ) : null}
          {canManage && canRetry ? (
            <Button disabled={busy} onClick={() => recover('retry')}>
              Retry failed run
            </Button>
          ) : null}
        </>
      }
      description={
        <span className="flex flex-wrap items-center gap-2">
          <RunStatusPill status={run.status} />
          {run.cancelRequested && runActive(run.status) ? (
            <Pill tone="yellow">Cancellation requested</Pill>
          ) : null}
          <span>{run.reason || event.reason}</span>
        </span>
      }
      title={event.snapshot.title}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {run.failureCode ? (
        <Alert>
          <AlertDescription>
            {FAILURE_CODES[run.failureCode] ?? run.failureCode}{' '}
            {run.status === 'needs_attention'
              ? 'Fix the configuration or evidence, then let the next event run. There is no blind retry for this state.'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      <Section title="Summary">
        <dl className="grid gap-4 rounded-2xl p-5 ring-1 ring-border sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Workflow">
            {definition ? (
              <Link className="underline" href={`/workflows/${definition.id}`}>
                {definition.name}
              </Link>
            ) : (
              runHandler(detail)
            )}
          </Field>
          <Field label="Version">
            {run.versionRevision ? `Revision ${run.versionRevision}` : '—'}
          </Field>
          <Field label="Trigger">{FAMILY_NAMES[event.snapshot.family]}</Field>
          <Field label="Triggering object">
            {event.snapshot.url ? (
              <a className="underline" href={event.snapshot.url} rel="noreferrer" target="_blank">
                {triggeringObject(detail)}
              </a>
            ) : (
              triggeringObject(detail)
            )}
          </Field>
          <Field label="Repository">{event.snapshot.repositoryName}</Field>
          <Field label="Received">{new Date(event.receivedAt).toLocaleString()}</Field>
          <Field label="Duration">{duration(run.createdAt, run.completedAt)}</Field>
          <Field label="Recovery attempts">{run.recoveryAttempt}</Field>
          <Field label="Delivery">{event.deliveryId}</Field>
          <Field label="Semantic event">{event.snapshot.semanticKey}</Field>
          <Field label="Origin">{event.snapshot.origin}</Field>
          <Field label="Accepted versions">{event.versionIds.length}</Field>
        </dl>
      </Section>

      <Section
        description="Product records this run created. A campaign's review state is its own."
        title="Outputs"
      >
        <Group>
          {run.outputs.releaseId ? (
            <Row label="Release" layout="inline">
              <ButtonLink href={`/releases/${run.outputs.releaseId}`} size="sm" variant="outline">
                Open release
              </ButtonLink>
            </Row>
          ) : null}
          {run.outputs.campaignId ? (
            <Row
              description={
                review === null
                  ? 'Loading review state…'
                  : review === 'unavailable'
                    ? 'Review state is unavailable to your role.'
                    : `Campaign ${review.status.toLowerCase().replaceAll('_', ' ')} · ${Object.entries(
                        review.posts.reduce<Record<string, number>>((counts, post) => {
                          counts[post.status] = (counts[post.status] ?? 0) + 1
                          return counts
                        }, {})
                      )
                        .map(
                          ([status, count]) =>
                            `${count} ${status.toLowerCase().replaceAll('_', ' ')}`
                        )
                        .join(', ')}`
              }
              label={`Campaign · ${run.outputs.postIds?.length ?? 0} post${run.outputs.postIds?.length === 1 ? '' : 's'}`}
              layout="inline"
            >
              <ButtonLink
                href={`/campaigns/${run.outputs.campaignId}/copy`}
                size="sm"
                variant="outline"
              >
                Open campaign drafts
              </ButtonLink>
            </Row>
          ) : null}
          {run.outputs.renderedAssetIds?.length && run.outputs.campaignId ? (
            <Row
              description="Rendered from the latest product capture in the brand kit. A reviewer approves a design before it can be scheduled."
              label={`Creatives · ${run.outputs.renderedAssetIds.length} rendered`}
              layout="inline"
            >
              <ButtonLink
                href={`/campaigns/${run.outputs.campaignId}/assets`}
                size="sm"
                variant="outline"
              >
                Open creatives
              </ButtonLink>
            </Row>
          ) : null}
          {run.outputs.captureAssetId ? (
            <Row
              description="The product screenshot this run captured. It opens in the editor with the active brand kit; its export becomes a draft."
              label="Screenshot · captured"
              layout="inline"
            >
              <Suspense
                fallback={
                  <Button disabled size="sm" variant="outline">
                    Open screenshot in the editor
                  </Button>
                }
              >
                <CaptureEditorLink
                  assetId={run.outputs.captureAssetId}
                  brandKit={brandKit}
                  from={
                    run.outputs.campaignId
                      ? { campaignId: run.outputs.campaignId }
                      : run.outputs.releaseId
                        ? { releaseId: run.outputs.releaseId }
                        : {}
                  }
                />
              </Suspense>
            </Row>
          ) : null}
          {run.outputs.canvasId ? (
            <Row
              description="Laid out from the release record. Refine it, then export or hand it to a campaign."
              label="Canvas · laid out"
              layout="inline"
            >
              <ButtonLink href={`/canvas/${run.outputs.canvasId}`} size="sm" variant="outline">
                Open canvas
              </ButtonLink>
            </Row>
          ) : null}
          {run.outputs.creditsCharged ? (
            <Row
              description="Charged once for this run, within the node's limit."
              label="AI credits"
              layout="inline"
            >
              <span className="text-sm tabular-nums">{run.outputs.creditsCharged}</span>
            </Row>
          ) : null}
          {!run.outputs.releaseId && !run.outputs.campaignId ? (
            <Row>
              <p className="text-sm text-muted-foreground">
                This run produced no release or campaign.
              </p>
            </Row>
          ) : null}
        </Group>
      </Section>

      <Section
        description="The pinned version this run executed. Highlighted nodes ran; red ones stopped the run. Select a node to inspect it."
        title="Execution path"
      >
        {graph ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div
              aria-label="Executed workflow graph"
              className="h-[420px] overflow-hidden rounded-2xl ring-1 ring-border"
              role="region"
            >
              <ReactFlow
                edges={canvasEdges(graph, path)}
                fitView
                maxZoom={1.25}
                minZoom={0.15}
                nodeTypes={workflowNodeTypes}
                nodes={canvasNodes(graph, definition?.layout ?? {}, {
                  selected,
                  path: new Set(path),
                  invalid: failed,
                  sourceName: event.snapshot.repositoryName,
                })}
                nodesConnectable={false}
                nodesDraggable={false}
                className="[--xy-controls-button-background-color:var(--card)] [--xy-controls-button-background-color-hover:var(--muted)] [--xy-controls-button-color:var(--foreground)] [--xy-controls-button-border-color:var(--border)]"
                onNodeClick={(_, clicked) => setSelected(clicked.id)}
              >
                <Background gap={20} size={1} color="var(--border)" />
                <Controls
                  showInteractive={false}
                  className="!overflow-hidden !rounded-lg !border !border-border !shadow-sm"
                />
              </ReactFlow>
            </div>
            <aside aria-label="Node details" className="rounded-2xl p-4 text-sm ring-1 ring-border">
              {node ? (
                <dl className="flex flex-col gap-3">
                  <Field label="Node">
                    {nodeLabel(node, graph.family)} · {node.id}
                  </Field>
                  {node.condition ? (
                    <Field label="Condition">{conditionSummary(node.condition)}</Field>
                  ) : null}
                  {node.classify ? (
                    <Field label="AI criteria">
                      {node.classify.criteria} (threshold {node.classify.threshold})
                    </Field>
                  ) : null}
                  {receipt?.decision.score !== undefined ? (
                    <Field label="AI confidence">{receipt.decision.score.toFixed(2)}</Field>
                  ) : null}
                  {node.action?.type === 'generate_copy' ? (
                    <Field label="Credit limit">{node.action.creditLimit}</Field>
                  ) : null}
                  {receipt ? (
                    <>
                      <Field label="Status">
                        {receipt.status} · {receipt.attempts} attempt
                        {receipt.attempts === 1 ? '' : 's'}
                      </Field>
                      {receipt.decision.status ? (
                        <Field label="Decision">
                          {receipt.decision.status === 'evaluated'
                            ? `${receipt.decision.match ? 'True' : 'False'} branch`
                            : receipt.decision.status}{' '}
                          · {receipt.decision.reason}
                        </Field>
                      ) : null}
                      {receipt.failureCode ? (
                        <Field label="Failure">
                          {FAILURE_CODES[receipt.failureCode] ?? receipt.failureCode}
                        </Field>
                      ) : null}
                      <Field label="Started">{new Date(receipt.startedAt).toLocaleString()}</Field>
                      <Field label="Completed">
                        {receipt.completedAt ? new Date(receipt.completedAt).toLocaleString() : '—'}
                      </Field>
                      <Field label="Action key">{receipt.actionKey}</Field>
                    </>
                  ) : (
                    <p className="text-muted-foreground">This node did not run.</p>
                  )}
                </dl>
              ) : (
                <p className="text-muted-foreground">Select a node on the graph or the timeline.</p>
              )}
            </aside>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No version was selected for this event, so no graph ran. {run.reason}
          </p>
        )}
      </Section>

      <Section
        description="Persisted node receipts, oldest first. Retries reuse each node's action key."
        title="Timeline"
      >
        <ol aria-label="Run timeline" className="flex flex-col gap-2">
          <li className="rounded-xl p-3 text-sm ring-1 ring-border">
            Event received · {new Date(event.receivedAt).toLocaleString()} · Handled by{' '}
            {event.mode === 'legacy' ? 'Release inbox' : 'workflows'}
          </li>
          {receipts.map((item) => (
            <li key={item.nodeId}>
              <Button
                className="flex h-auto w-full flex-wrap items-center justify-between gap-2 rounded-xl p-3 text-left whitespace-normal"
                onClick={() => setSelected(item.nodeId)}
                type="button"
                variant="outline"
              >
                <span className="font-medium">
                  {graph
                    ? nodeLabel(
                        graph.nodes.find((candidate) => candidate.id === item.nodeId) ?? {
                          id: item.nodeId,
                          type: 'action',
                        },
                        graph.family
                      )
                    : item.nodeId}{' '}
                  · {item.nodeId}
                </span>
                <span className="text-xs font-normal text-muted-foreground">
                  {item.status} · {item.attempts} attempt{item.attempts === 1 ? '' : 's'}
                  {item.decision.status === 'evaluated'
                    ? ` · ${item.decision.match ? 'true' : 'false'} branch`
                    : item.decision.status
                      ? ' · no branch selected'
                      : ''}
                  {item.failureCode ? ` · ${item.failureCode}` : ''}
                  {item.outputs.creditsCharged ? ` · ${item.outputs.creditsCharged} credits` : ''}
                </span>
              </Button>
            </li>
          ))}
          {run.completedAt ? (
            <li className="rounded-xl p-3 text-sm ring-1 ring-border">
              Finished {run.status.replaceAll('_', ' ')} ·{' '}
              {new Date(run.completedAt).toLocaleString()}
            </li>
          ) : null}
        </ol>
      </Section>

      <Section
        description="The event this run checked. Its text comes from GitHub and is not trusted as instructions; no raw payload or credential is kept."
        title="Event evidence"
      >
        <div className="overflow-x-auto rounded-2xl ring-1 ring-border">
          <Table aria-label="Event fields" className="w-full text-left text-sm">
            <TableBody>
              {Object.entries(fields).map(([field, value]) => (
                <TableRow className="border-t border-border first:border-t-0" key={field}>
                  <TableHead
                    className="px-4 py-2 font-mono text-xs font-normal text-muted-foreground"
                    scope="row"
                  >
                    {field}
                  </TableHead>
                  <TableCell className="px-4 py-2 text-xs text-muted-foreground">
                    {value.state}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-xs break-all whitespace-normal text-foreground">
                    {value.boolean !== undefined
                      ? String(value.boolean)
                      : value.values?.length
                        ? value.values.slice(0, 20).join(', ') +
                          (value.values.length > 20 ? ` … ${value.values.length} total` : '')
                        : value.state === 'available'
                          ? '(empty)'
                          : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {event.snapshot.notes ? (
          <div>
            <h3 className="mb-2 text-ui-lg font-medium">Release notes (Markdown)</h3>
            <pre className="max-h-64 overflow-auto rounded-2xl p-4 text-xs whitespace-pre-wrap text-muted-foreground ring-1 ring-border">
              {event.snapshot.notes}
            </pre>
          </div>
        ) : null}
      </Section>
    </Page>
  )
}

/** The run's captured screenshot, opened in the editor on the active brand kit. */
function CaptureEditorLink({
  assetId,
  brandKit,
  from,
}: {
  assetId: string
  brandKit: Promise<{ kitId: string | null } | null>
  from: EditorReturn
}) {
  const brand = use(brandKit)
  return (
    <span className="flex flex-wrap items-center gap-2">
      {brand ? null : (
        <span className="text-xs text-muted-foreground" role="status">
          The brand kit could not be read; apply it from Brand in the editor.
        </span>
      )}
      <ButtonLink
        data-testid="run-open-editor"
        href={editorHref({ assetId, brandKitId: brand?.kitId ?? undefined }, from)}
        size="sm"
        variant="outline"
      >
        Open screenshot in the editor
      </ButtonLink>
    </span>
  )
}

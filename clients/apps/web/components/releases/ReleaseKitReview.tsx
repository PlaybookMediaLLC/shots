'use client'

import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  createReleaseKitSchema,
  prepareReleaseKitSchema,
  decideReleaseKitSchema,
  requestKitExportSchema,
  readinessMutationSchema,
  releaseKitSchema,
  kitExportSchema,
  kitPreviewSchema,
  releaseClaimsPageSchema,
  releaseQualificationSchema,
  type KitArtifactInput,
  type ReleaseQualification,
  type DecideReleaseKitInput,
} from 'screenshot-studio-backend-sdk'
import { Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { settingsRequest, SettingsRequestError, settingsErrorMessage } from '@/lib/settings/client'
import { KitArtifactComposer } from './KitArtifactComposer'

type Command = { path: string; body: unknown; key: string }
type Selection = { input: KitArtifactInput; label: string }
const title = (value: string) => value.replaceAll('_', ' ').toLowerCase()

/** One private preview; mounting again performs a new authorized read. */
function KitPreview({
  path,
  scope,
  onClose,
}: {
  path: string
  scope: { workspaceId: string; userId: string }
  onClose: () => void
}) {
  const query = useQuery({
    queryKey: ['kit-preview', scope, path],
    queryFn: ({ signal }) => settingsRequest(path, kitPreviewSchema, { scope, signal }),
    staleTime: 0,
    gcTime: 0,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Prepared artifact preview</DialogTitle>
        </DialogHeader>
        <p className="font-semibold text-amber-700 dark:text-amber-300">
          Preview — not approved for distribution
        </p>
        {query.isPending ? (
          <p role="status">Loading exact prepared output…</p>
        ) : query.isError ? (
          <div role="alert">
            <p>{settingsErrorMessage(query.error)}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry preview
            </Button>
          </div>
        ) : query.data.kind === 'image' ? (
          <img
            src={query.data.content}
            alt="Watermarked prepared kit artifact"
            className="max-h-[70dvh] object-contain"
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words text-sm">{query.data.content}</pre>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Manual kit assembly, exact-byte review and live-gated approved export. */
export function ReleaseKitReview({
  releaseId,
  workspaceId,
  userId,
  qualification,
  members,
  canEdit,
  canDecide,
  disabled,
  onRevision,
  onReload,
  onEditing,
}: {
  releaseId: string
  workspaceId: string
  userId: string
  qualification: ReleaseQualification
  members: { userId: string; name: string; role: string }[]
  canEdit: boolean
  canDecide: boolean
  disabled: boolean
  onRevision: (revision: string) => void
  onReload: (qualification: ReleaseQualification) => void
  onEditing: (editing: boolean) => void
}) {
  const base = `/api/v1/releases/${encodeURIComponent(releaseId)}`
  const scope = useMemo(() => ({ workspaceId, userId }), [workspaceId, userId])
  const [historyId, setHistoryId] = useState('')
  const [assembling, setAssembling] = useState(false)
  const [selection, setSelection] = useState<Selection[]>([])
  const [approver, setApprover] = useState(userId)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState([false, false, false])
  const [pending, setPending] = useState<Command | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [exportId, setExportId] = useState('')
  const [audiences, setAudiences] = useState<string[]>([])
  const dirty = assembling || reason.trim().length > 0 || pending !== null
  useUnsavedSettings(dirty)
  useEffect(() => {
    onEditing(dirty)
    return () => onEditing(false)
  }, [dirty, onEditing])
  const query = useQuery({
    queryKey: ['release-kit', workspaceId, userId, releaseId, qualification.revision, historyId],
    queryFn: async ({ signal }) => {
      try {
        return await settingsRequest(
          `${base}/kits${historyId ? `?revisionId=${encodeURIComponent(historyId)}` : ''}`,
          releaseKitSchema,
          { scope, signal }
        )
      } catch (failure) {
        if (failure instanceof SettingsRequestError && failure.status === 404 && !historyId)
          return null
        throw failure
      }
    },
    refetchInterval: (state) => (state.state.data?.state === 'BUILDING' ? 2000 : false),
  })
  const kit = query.data
  const claims = useInfiniteQuery({
    queryKey: ['release-claims', workspaceId, userId, releaseId, qualification.revision],
    initialPageParam: undefined as string | undefined,
    enabled: assembling,
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `${base}/claims${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        releaseClaimsPageSchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const activeExport = exportId || kit?.exportIds[0] || ''
  const exported = useQuery({
    queryKey: ['kit-export', workspaceId, userId, activeExport],
    enabled: Boolean(activeExport),
    queryFn: ({ signal }) =>
      settingsRequest(`${base}/kit-exports/${encodeURIComponent(activeExport)}`, kitExportSchema, {
        scope,
        signal,
      }),
    refetchInterval: (state) => (state.state.data?.state === 'BUILDING' ? 2000 : false),
  })
  const writable =
    qualification.enabled &&
    qualification.canonicalState === 'ACTIVE' &&
    !disabled &&
    !busy &&
    !pending &&
    !stale &&
    !query.isPending &&
    !query.isError &&
    !historyId
  const reviewer = canDecide && kit?.approverUserId === userId
  const send = async (command: Command) => {
    if (busy) return
    setPending(command)
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await settingsRequest(command.path, readinessMutationSchema, {
        scope,
        method: 'POST',
        body: command.body,
        commandKey: command.key,
      })
      onRevision(result.revision)
      if (command.path.endsWith('/exports')) setExportId(result.id ?? '')
      else setExportId('')
      setPending(null)
      setReason('')
      setConfirmed([false, false, false])
      setAssembling(false)
      setSelection([])
      setMessage('Saved. This revision and its decisions remain in the release history.')
      await query.refetch()
    } catch (failure) {
      setError(settingsErrorMessage(failure))
      if (
        failure instanceof SettingsRequestError &&
        failure.status < 500 &&
        failure.status !== 429
      ) {
        setPending(null)
        if ([401, 403, 404, 409].includes(failure.status)) setStale(true)
      }
    } finally {
      setBusy(false)
    }
  }
  const run = async (suffix: string, body: () => unknown) => {
    try {
      await send({ path: `${base}/${suffix}`, body: body(), key: crypto.randomUUID() })
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    }
  }
  const reload = async () => {
    if (busy || pending) return
    try {
      onReload(
        await settingsRequest(`${base}/qualification`, releaseQualificationSchema, { scope })
      )
      await query.refetch()
      setStale(false)
      setError(null)
      setMessage(
        'Latest saved state loaded. Your candidate and review notes are kept; compare them before submitting again.'
      )
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    }
  }
  const decide = (
    reviewType: DecideReleaseKitInput['reviewType'],
    decision: DecideReleaseKitInput['decision']
  ) => {
    if (!kit) return
    void run(`kits/${kit.id}/decisions`, () =>
      decideReleaseKitSchema.parse({
        expectedRevision: qualification.revision,
        manifestSha256: kit.readiness.manifestHash,
        dependencyToken: kit.readiness.dependencyToken,
        reviewType,
        decision,
        reason,
        assertionsConfirmed: confirmed[0],
        screenshotsConfirmed: confirmed[1],
        audienceConfirmed: confirmed[2],
      })
    )
  }
  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await settingsRequest(
        `${base}/kit-exports/${encodeURIComponent(activeExport)}?download=true`,
        kitExportSchema,
        { scope }
      )
      if (!result.downloadUrl) throw new Error('The approved export is not ready.')
      const link = document.createElement('a')
      link.href = result.downloadUrl
      link.download = `release-kit-${kit?.version ?? ''}.zip`
      link.rel = 'noopener noreferrer'
      link.click()
    } catch (failure) {
      setError(settingsErrorMessage(failure))
      await query.refetch()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title="Release kit"
      description="Prepare exact materials for each audience. Human coverage review and final approval are separate steps."
    >
      <div className="space-y-5">
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
        {pending ? (
          <div role="alert" className="space-y-2">
            <p>The result is unconfirmed. Retry the same request to recover its recorded result.</p>
            <Button variant="outline" disabled={busy} onClick={() => void send(pending)}>
              Retry same kit request
            </Button>
          </div>
        ) : null}
        {stale ? (
          <div role="alert">
            <p>The release or your access changed. Reload before submitting again.</p>
            <Button
              variant="outline"
              disabled={busy || Boolean(pending)}
              onClick={() => void reload()}
            >
              Reload kit state
            </Button>
          </div>
        ) : null}
        {query.isPending ? (
          <p role="status">Loading kit…</p>
        ) : query.isError ? (
          <div role="alert">
            <p>{settingsErrorMessage(query.error)}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry kit
            </Button>
          </div>
        ) : !kit ? (
          <p className="text-sm text-muted-foreground">
            No kit yet. Qualify the release, verify its claims, then assemble the materials your
            audiences need.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <p className="font-medium">
                Revision {kit.version} · {title(kit.state)}
              </p>
              <Combobox
                aria-label="Kit revision history"
                disabled={dirty || busy}
                value={historyId || kit.id}
                onValueChange={(id) => {
                  setHistoryId(id)
                  setExportId('')
                  setAudiences([])
                }}
                options={kit.history.map((row) => ({
                  value: row.id,
                  label: `Revision ${row.version} · ${title(row.state)}`,
                }))}
              />
              {historyId ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setHistoryId('')
                    setExportId('')
                  }}
                >
                  Return to current kit
                </Button>
              ) : null}
            </div>
            {kit.failureCode ? (
              <p role="alert">
                Preparation stopped: {title(kit.failureCode)}. Correct the source and create a
                replacement revision.
              </p>
            ) : null}
            {kit.state === 'BUILDING' ? (
              <p role="status">
                Preparing frozen content. You can leave this page; the job continues.
              </p>
            ) : null}
            <ul className="divide-y rounded-xl border">
              {kit.artifacts.map((artifact) => (
                <li key={artifact.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      {title(artifact.kind)} ·{' '}
                      {qualification.current?.facts.requirements.find(
                        (audience) => audience.id === artifact.audienceId
                      )?.label || artifact.audienceId}
                    </p>
                    <Button
                      variant="outline"
                      disabled={!artifact.prepared || busy}
                      onClick={() =>
                        setPreview(`${base}/kits/${kit.id}/artifacts/${artifact.id}/preview`)
                      }
                    >
                      Review prepared content
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {title(artifact.sourceKind)} · saved revision {artifact.sourceRevision} ·{' '}
                    {artifact.claims.length} mapped claims · {title(artifact.classification)}
                  </p>
                  {artifact.markdown && !artifact.prepared ? (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-sm">
                      {artifact.markdown}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
            {kit.omissions.length ? (
              <ul className="text-sm">
                {kit.omissions.map((item) => (
                  <li key={`${item.audienceId}-${item.material}`}>
                    Omitted {title(item.material)} for {item.audienceId}: {item.reason} · owner{' '}
                    {members.find((member) => member.userId === item.ownerId)?.name || item.ownerId}
                  </li>
                ))}
              </ul>
            ) : null}
            {kit.readiness.blockers.length ? (
              <div className="rounded-xl border p-4">
                <p className="mb-2 font-medium">Before this kit can be used</p>
                <ul className="space-y-2 text-sm">
                  {kit.readiness.blockers.map((blocker, index) => (
                    <li key={`${blocker.code}-${blocker.objectId}-${index}`}>
                      <strong>{title(blocker.code)}:</strong> {blocker.repairAction}
                      {blocker.audienceId ? ` (${blocker.audienceId})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p role="status">Ready for approved export and handoff.</p>
            )}
            {kit.state === 'DRAFT' ? (
              <Button
                disabled={!writable || !canEdit || assembling}
                onClick={() =>
                  void run(`kits/${kit.id}/prepare`, () =>
                    prepareReleaseKitSchema.parse({
                      expectedRevision: qualification.revision,
                      snapshots: kit.artifacts.map((artifact) => ({
                        artifactRevisionId: artifact.id,
                        snapshotSha256: artifact.snapshotSha256,
                      })),
                    })
                  )
                }
              >
                Freeze and prepare outputs
              </Button>
            ) : null}
          </>
        )}
        {canEdit && !assembling ? (
          <Button
            variant="outline"
            disabled={!writable || !qualification.current || kit?.state === 'BUILDING'}
            onClick={() => {
              setSelection(
                kit?.artifacts.map((artifact) => ({
                  input: { existingArtifactId: artifact.id },
                  label: `${title(artifact.kind)} · ${artifact.audienceId} · retained artifact`,
                })) ?? []
              )
              setApprover(
                kit?.approverUserId || qualification.current?.facts.factReviewerUserId || userId
              )
              setAssembling(true)
            }}
          >
            {kit ? 'Create replacement revision' : 'Assemble release kit'}
          </Button>
        ) : null}
        {assembling ? (
          <div className="space-y-4 rounded-xl border p-4">
            <p className="text-sm">
              Retain unchanged artifacts. Remove and add only the material you want to replace.
              Saving creates a new revision; previous approvals remain in history.
            </p>
            <Label htmlFor="kit-approver">Kit approver</Label>
            <Combobox
              id="kit-approver"
              value={approver}
              disabled={!writable}
              onValueChange={setApprover}
              options={members
                .filter((member) => ['owner', 'admin', 'approver'].includes(member.role))
                .map((member) => ({ value: member.userId, label: member.name }))}
            />
            <ul className="space-y-2">
              {selection.map((item, index) => (
                <li key={index} className="flex items-center justify-between gap-2">
                  <span className="text-sm">{item.label}</span>
                  <Button
                    variant="ghost"
                    disabled={!writable}
                    onClick={() => setSelection((current) => current.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            {claims.isPending ? (
              <p role="status">Loading verified claims…</p>
            ) : claims.isError ? (
              <div role="alert">
                <p>Claims could not load.</p>
                <Button variant="outline" onClick={() => void claims.refetch()}>
                  Retry claims
                </Button>
              </div>
            ) : (
              <KitArtifactComposer
                qualification={qualification}
                scope={scope}
                disabled={!writable || selection.length >= 50}
                claims={claims.data.pages.flatMap((page) => page.items)}
                onAdd={(input, label) => setSelection((current) => [...current, { input, label }])}
              />
            )}
            {claims.hasNextPage ? (
              <Button
                variant="outline"
                disabled={claims.isFetchingNextPage}
                onClick={() => void claims.fetchNextPage()}
              >
                More claims
              </Button>
            ) : null}
            <div className="flex gap-2">
              <Button
                disabled={!writable || !selection.length || !approver}
                onClick={() =>
                  void run('kits', () =>
                    createReleaseKitSchema.parse({
                      expectedRevision: qualification.revision,
                      expectedKitRevisionId: kit?.id ?? null,
                      qualificationRevisionId: qualification.current?.id,
                      approverUserId: approver,
                      artifacts: selection.map((item) => item.input),
                    })
                  )
                }
              >
                Save kit candidate
              </Button>
              <Button
                variant="outline"
                disabled={busy || Boolean(pending)}
                onClick={() => {
                  if (window.confirm('Discard the unsaved kit selection?')) {
                    setAssembling(false)
                    setSelection([])
                  }
                }}
              >
                Cancel assembly
              </Button>
            </div>
          </div>
        ) : null}
        {kit &&
        reviewer &&
        ['REVIEWABLE', 'APPROVED'].includes(kit.state) &&
        !historyId &&
        !assembling ? (
          <div className="space-y-3 rounded-xl border p-4">
            <p className="font-medium">Review this exact revision</p>
            {kit.state === 'REVIEWABLE'
              ? [
                  'Every factual assertion is mapped to a verified claim, or is non-factual context.',
                  'Screenshots match the qualified behavior and contain no sensitive data.',
                  'Each artifact is suitable for its stated audience.',
                ].map((label, index) => (
                  <div key={label} className="flex items-start gap-2">
                    <Checkbox
                      id={`kit-confirm-${index}`}
                      checked={confirmed[index]}
                      disabled={!writable}
                      onCheckedChange={(value) =>
                        setConfirmed((current) =>
                          current.map((item, i) => (i === index ? value === true : item))
                        )
                      }
                    />
                    <Label htmlFor={`kit-confirm-${index}`}>{label}</Label>
                  </div>
                ))
              : null}
            <Label htmlFor="kit-review-reason">Review note</Label>
            <Textarea
              id="kit-review-reason"
              value={reason}
              disabled={!writable}
              onChange={(event) => setReason(event.target.value)}
              maxLength={8192}
            />
            <div className="flex flex-wrap gap-2">
              {kit.state === 'REVIEWABLE' ? (
                <>
                  <Button
                    disabled={!writable || !reason.trim() || !confirmed.every(Boolean)}
                    onClick={() => decide('CONTENT_COVERAGE', 'APPROVE')}
                  >
                    Confirm content coverage
                  </Button>
                  <Button
                    disabled={!writable || !reason.trim() || !kit.readiness.canApprove}
                    onClick={() => decide('FINAL_APPROVAL', 'APPROVE')}
                  >
                    Approve kit
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!writable || !reason.trim()}
                    onClick={() => decide('CONTENT_COVERAGE', 'REJECT')}
                  >
                    Request changes
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  disabled={!writable || !reason.trim()}
                  onClick={() => decide('FINAL_APPROVAL', 'WITHDRAW')}
                >
                  Withdraw kit approval
                </Button>
              )}
            </div>
          </div>
        ) : null}
        {kit?.state === 'APPROVED' && !historyId ? (
          <div className="space-y-3 rounded-xl border p-4">
            <p className="font-medium">Approved export</p>
            {(qualification.current?.facts.requirements ?? []).map((audience) => (
              <div key={audience.id} className="flex gap-2">
                <Checkbox
                  id={`kit-export-${audience.id}`}
                  checked={audiences.includes(audience.id)}
                  disabled={!writable}
                  onCheckedChange={(value) =>
                    setAudiences((current) =>
                      value === true
                        ? [...current, audience.id]
                        : current.filter((id) => id !== audience.id)
                    )
                  }
                />
                <Label htmlFor={`kit-export-${audience.id}`}>
                  {audience.label || title(audience.kind)}
                </Label>
              </div>
            ))}
            <Button
              disabled={!writable || !kit.readiness.canExportApproved || !audiences.length}
              onClick={() =>
                void run(`kits/${kit.id}/exports`, () =>
                  requestKitExportSchema.parse({
                    expectedRevision: qualification.revision,
                    manifestSha256: kit.readiness.manifestHash,
                    audienceIds: audiences,
                  })
                )
              }
            >
              Prepare approved ZIP
            </Button>
            {activeExport && exported.isPending ? (
              <p role="status">Loading export…</p>
            ) : exported.isError ? (
              <p role="alert">{settingsErrorMessage(exported.error)}</p>
            ) : exported.data ? (
              <div>
                <p className="text-sm">
                  Export {title(exported.data.state)}
                  {exported.data.failureCode ? `: ${title(exported.data.failureCode)}` : ''}
                </p>
                {exported.data.state === 'READY' ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Audiences: {exported.data.fileIndex.audienceIds.join(', ')}. Downloaded files
                      cannot be recalled.
                    </p>
                    <Button
                      variant="outline"
                      disabled={busy || !kit.readiness.canExportApproved}
                      onClick={() => void download()}
                    >
                      Download approved ZIP
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {kit?.decisions.length ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">Review history</p>
            {kit.decisions.map((decision) => (
              <p key={decision.id}>
                {title(decision.reviewType)} · {title(decision.decision)} ·{' '}
                {members.find((member) => member.userId === decision.humanUserId)?.name ||
                  'Reviewer'}{' '}
                — {decision.reason}
              </p>
            ))}
          </div>
        ) : null}
      </div>
      {preview ? (
        <KitPreview key={preview} path={preview} scope={scope} onClose={() => setPreview(null)} />
      ) : null}
    </Section>
  )
}

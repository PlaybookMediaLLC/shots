'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  mergeReleaseSchema,
  splitReleaseSchema,
  releaseLineageHistorySchema,
  releaseLineageResultSchema,
  releaseQualificationSchema,
  releaseSourcePageSchema,
  type MergeReleaseInput,
  type SplitReleaseInput,
  type ReleaseQualification,
} from 'screenshot-studio-backend-sdk'
import { Section } from '@/components/platform-ui'
import { RECENT_WORK_KEY } from '@/components/platform-hub/work'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { releaseChoicesSchema } from '@/lib/api/contracts/releases'
import { SettingsRequestError, settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

type Scope = { userId: string; workspaceId: string }
type Pending =
  | { kind: 'merge'; body: MergeReleaseInput; key: string }
  | { kind: 'split'; body: SplitReleaseInput; key: string }

function GroupingHistory({
  releaseId,
  scope,
  onClose,
}: {
  releaseId: string
  scope: Scope
  onClose: () => void
}) {
  const history = useInfiniteQuery({
    queryKey: ['release-lineage', scope.workspaceId, scope.userId, releaseId],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `/api/v1/releases/${encodeURIComponent(releaseId)}/qualification/lineage?${new URLSearchParams(pageParam ? { cursor: pageParam } : {})}`,
        releaseLineageHistorySchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const items = history.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge and split history</DialogTitle>
          <DialogDescription>
            Each change keeps its original releases, source references and human reason.
          </DialogDescription>
        </DialogHeader>
        {history.isPending ? <p role="status">Loading release history…</p> : null}
        {history.isError ? (
          <div role="alert">
            <p>{settingsErrorMessage(history.error)}</p>
            <Button variant="outline" onClick={() => void history.refetch()}>
              Retry history
            </Button>
          </div>
        ) : null}
        {history.isSuccess && !items.length ? (
          <p>No merges or splits recorded for this release.</p>
        ) : null}
        <ol className="grid gap-3">
          {items.map((item) => (
            <li key={item.id} className="grid gap-2 rounded-md border p-3">
              <p className="font-medium">
                {item.operation === 'MERGE' ? 'Merged releases' : 'Split source evidence'} ·{' '}
                {new Date(item.createdAt).toLocaleString()}
              </p>
              <p className="whitespace-pre-wrap break-words">{item.reason}</p>
              <p className="text-sm">
                {item.bindingIds.length} source{' '}
                {item.bindingIds.length === 1 ? 'object' : 'objects'} moved. Saved facts and
                campaigns retain their original history.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link className="underline" href={`/releases/${item.sourceReleaseId}`}>
                  Original release
                </Link>
                <Link className="underline" href={`/releases/${item.destinationReleaseId}`}>
                  Destination release
                </Link>
              </div>
            </li>
          ))}
        </ol>
        {history.hasNextPage ? (
          <Button
            variant="outline"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            Older grouping changes
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Close history
        </Button>
      </DialogContent>
    </Dialog>
  )
}

function GroupingDialog({
  kind,
  data,
  scope,
  canEdit,
  onGrouped,
  onClose,
}: {
  kind: 'merge' | 'split'
  data: ReleaseQualification
  scope: Scope
  canEdit: boolean
  onGrouped: () => Promise<void>
  onClose: () => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [benefit, setBenefit] = useState('')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [destination, setDestination] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[]>([])
  const sourceReleaseId = kind === 'merge' ? target : data.releaseId
  const dirty =
    !saved.length &&
    Boolean(pending || target || selected.length || title.trim() || benefit.trim() || reason.trim())
  useUnsavedSettings(dirty)
  const releases = useQuery({
    queryKey: ['grouping-release-choices', scope.workspaceId, scope.userId, submittedSearch],
    enabled: kind === 'merge',
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: ({ signal }) =>
      settingsRequest(
        `/api/v1/releases?${new URLSearchParams({ limit: '50', search: submittedSearch })}`,
        releaseChoicesSchema,
        { scope, signal }
      ),
  })
  const targetFacts = useQuery({
    queryKey: ['grouping-release-facts', scope.workspaceId, scope.userId, target],
    enabled: kind === 'merge' && Boolean(target),
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: ({ signal }) =>
      settingsRequest(
        `/api/v1/releases/${encodeURIComponent(target ?? '')}/qualification`,
        releaseQualificationSchema,
        { scope, signal }
      ),
  })
  const sources = useInfiniteQuery({
    queryKey: ['grouping-release-sources', scope.workspaceId, scope.userId, sourceReleaseId],
    enabled: Boolean(sourceReleaseId),
    initialPageParam: '',
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `/api/v1/release-sources?${new URLSearchParams({ releaseId: sourceReleaseId ?? '', ...(pageParam ? { cursor: pageParam } : {}) })}`,
        releaseSourcePageSchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor,
  })
  const items = sources.data?.pages.flatMap((page) => page.items) ?? []
  const eligible =
    canEdit && data.enabled && data.canonicalState === 'ACTIVE' && !data.firstQualifiedAt
  const locked = !eligible || busy || Boolean(pending) || stale || saved.length > 0
  const targetEligible =
    kind === 'split' ||
    Boolean(
      targetFacts.data?.enabled &&
      targetFacts.data.canonicalState === 'ACTIVE' &&
      !targetFacts.data.firstQualifiedAt
    )
  const choicesReady =
    sources.isSuccess &&
    !sources.isFetching &&
    items.length <= 200 &&
    !sources.hasNextPage &&
    items.every((source) => source.available)
  const close = () => {
    if (busy || pending) return
    if (dirty && !window.confirm('Discard this unsaved grouping change?')) return
    onClose()
  }
  const reload = async () => {
    if (busy || pending) return
    setBusy(true)
    setError(null)
    try {
      await onGrouped()
      const refreshed = await sources.refetch()
      if (refreshed.isError) throw refreshed.error
      if (target) {
        const facts = await targetFacts.refetch()
        if (facts.isError) throw facts.error
      }
      setSelected([])
      setStale(false)
      setDestination(null)
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const send = async (command: Pending) => {
    if (busy) return
    setPending(command)
    setBusy(true)
    setError(null)
    let committed = false
    try {
      const result = await settingsRequest(
        `/api/v1/releases/${encodeURIComponent(data.releaseId)}/qualification/${command.kind}`,
        releaseLineageResultSchema,
        { scope, method: 'POST', commandKey: command.key, body: command.body }
      )
      committed = true
      await onGrouped()
      for (const queryKey of [
        RECENT_WORK_KEY,
        ['shell-search'],
        ['release-sources', scope.workspaceId, scope.userId],
        ['release-lineage', scope.workspaceId, scope.userId],
        ['source-selection-target', scope.workspaceId, scope.userId],
      ])
        void queryClient.invalidateQueries({ queryKey })
      setSaved(
        command.kind === 'merge'
          ? [result.releaseId]
          : result.releases.slice(1).map((release) => release.releaseId)
      )
      setPending(null)
      router.refresh()
    } catch (failure) {
      setError(settingsErrorMessage(failure))
      if (
        !committed &&
        failure instanceof SettingsRequestError &&
        failure.status < 500 &&
        failure.status !== 429
      ) {
        setPending(null)
        if ([401, 403, 404, 409].includes(failure.status)) setStale(true)
        if (failure.details && 'canonicalReleaseId' in failure.details)
          setDestination(failure.details.canonicalReleaseId ?? null)
      }
    } finally {
      setBusy(false)
    }
  }
  const submit = () => {
    if (locked || !choicesReady || !targetEligible) return
    if (kind === 'merge') {
      if (!target || !targetFacts.data) return
      const parsed = mergeReleaseSchema.safeParse({
        expectedRevision: data.revision,
        sources: [{ releaseId: target, expectedRevision: targetFacts.data.revision }],
        bindingIds: items.map((source) => source.id),
        reason,
      })
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Check the grouping change.')
        return
      }
      void send({ kind, key: crypto.randomUUID(), body: parsed.data })
    } else {
      const parsed = splitReleaseSchema.safeParse({
        expectedRevision: data.revision,
        groups: [{ bindingIds: selected, newRelease: { title, benefitStatement: benefit } }],
        reason,
      })
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Check the grouping change.')
        return
      }
      void send({ kind, key: crypto.randomUUID(), body: parsed.data })
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        showCloseButton={!pending && !busy}
        className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>
            {kind === 'merge'
              ? 'Merge another release into this one'
              : 'Split sources into a new release'}
          </DialogTitle>
          <DialogDescription>
            Only releases that have never been qualified and have no approved or scheduled work can
            be grouped.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert" className="grid gap-2 rounded-md border border-destructive p-3">
            <p>{error}</p>
            {pending ? (
              <>
                <p>
                  Keep this form open. Retry the same request to recover its saved result safely.
                </p>
                <Button disabled={busy} variant="outline" onClick={() => void send(pending)}>
                  Retry grouping request
                </Button>
              </>
            ) : stale ? (
              <Button disabled={busy} variant="outline" onClick={() => void reload()}>
                Reload releases and sources
              </Button>
            ) : null}
            {destination ? (
              <Link className="underline" href={`/releases/${destination}`}>
                Open current release
              </Link>
            ) : null}
          </div>
        ) : null}
        {saved.length ? (
          <div role="status" className="grid gap-3">
            <p>
              {kind === 'merge' ? 'Releases merged.' : 'Sources split into a new release.'} Review
              the facts before qualification.
            </p>
            {saved.map((id) => (
              <Link className="underline" key={id} href={`/releases/${id}`}>
                {kind === 'merge' ? 'Continue with this release' : 'Open new release'}
              </Link>
            ))}
          </div>
        ) : (
          <>
            {!eligible ? (
              <p role="status">
                Save any pending work and use an active, never-qualified release with creator
                access.
              </p>
            ) : null}
            {kind === 'merge' ? (
              <div className="grid gap-3">
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    setSubmittedSearch(search)
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="grouping-search">Find a release to merge</Label>
                    <Input
                      id="grouping-search"
                      value={search}
                      disabled={locked}
                      onChange={(event) => setSearch(event.target.value)}
                      maxLength={200}
                    />
                  </div>
                  <Button className="self-end" variant="outline" disabled={locked} type="submit">
                    Search
                  </Button>
                </form>
                {releases.isPending ? <p role="status">Loading releases…</p> : null}
                {releases.isError ? (
                  <div role="alert">
                    <p>{settingsErrorMessage(releases.error)}</p>
                    <Button variant="outline" onClick={() => void releases.refetch()}>
                      Retry releases
                    </Button>
                  </div>
                ) : null}
                <Label htmlFor="grouping-release">Release to merge into this one</Label>
                <Combobox
                  id="grouping-release"
                  disabled={locked || !releases.isSuccess}
                  value={target}
                  onValueChange={setTarget}
                  options={(releases.data?.releases ?? [])
                    .filter(
                      (release) =>
                        release.id !== data.releaseId &&
                        !['ARCHIVED', 'CANCELLED'].includes(release.status)
                    )
                    .map((release) => ({ value: release.id, label: release.title }))}
                  placeholder="Choose a release"
                />
                {releases.data?.releases.length === 50 ? (
                  <p className="text-sm">
                    Showing 50 releases. Search by title to narrow the list.
                  </p>
                ) : null}
                {target && targetFacts.isPending ? (
                  <p role="status">Checking release eligibility…</p>
                ) : null}
                {targetFacts.isError ? (
                  <div role="alert">
                    <p>{settingsErrorMessage(targetFacts.error)}</p>
                    <Button variant="outline" onClick={() => void targetFacts.refetch()}>
                      Retry release facts
                    </Button>
                  </div>
                ) : null}
                {targetFacts.isSuccess && !targetEligible ? (
                  <p role="status">
                    This release cannot be merged. It has already been qualified, was merged, or has
                    readiness changes disabled.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-3">
                <Label htmlFor="grouping-title">New release title</Label>
                <Input
                  id="grouping-title"
                  value={title}
                  maxLength={160}
                  disabled={locked}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Label htmlFor="grouping-benefit">Why the new release matters</Label>
                <Textarea
                  id="grouping-benefit"
                  value={benefit}
                  maxLength={500}
                  disabled={locked}
                  onChange={(event) => setBenefit(event.target.value)}
                />
              </div>
            )}
            {sourceReleaseId ? (
              <div className="grid gap-3">
                <h3 className="font-medium">
                  {kind === 'merge' ? 'All sources that will move' : 'Choose sources to move'}
                </h3>
                {sources.isPending ? <p role="status">Loading source selection…</p> : null}
                {sources.isError ? (
                  <div role="alert">
                    <p>{settingsErrorMessage(sources.error)}</p>
                    <Button variant="outline" onClick={() => void sources.refetch()}>
                      Retry source selection
                    </Button>
                  </div>
                ) : null}
                {sources.isSuccess && !items.length ? (
                  <p>
                    No provider sources are attached.
                    {kind === 'merge'
                      ? ' The original brief and facts remain in history.'
                      : ' Add source evidence before splitting this release.'}
                  </p>
                ) : null}
                <ul className="grid gap-2">
                  {items.map((source) => (
                    <li key={source.id} className="flex items-start gap-3 rounded-md border p-3">
                      {kind === 'split' ? (
                        <Checkbox
                          id={`grouping-${source.id}`}
                          disabled={locked || !source.available}
                          checked={selected.includes(source.id)}
                          onCheckedChange={(checked) =>
                            setSelected((current) =>
                              checked === true
                                ? [...current, source.id]
                                : current.filter((id) => id !== source.id)
                            )
                          }
                        />
                      ) : null}
                      <div className="grid min-w-0 gap-1 break-words">
                        {kind === 'split' ? (
                          <Label htmlFor={`grouping-${source.id}`}>
                            {source.selected?.snapshot.title ??
                              source.current?.snapshot.title ??
                              'Source evidence'}
                          </Label>
                        ) : (
                          <p>
                            {source.selected?.snapshot.title ??
                              source.current?.snapshot.title ??
                              'Source evidence'}
                          </p>
                        )}
                        <p className="text-sm text-muted-foreground">
                          {source.sourceName} ·{' '}
                          {source.kind === 'PULL_REQUEST'
                            ? `PR #${source.providerObjectId}`
                            : 'Deployment'}
                          {!source.available ? ' · Reconnect this source before grouping' : ''}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {sources.hasNextPage ? (
                  <Button
                    variant="outline"
                    disabled={sources.isFetchingNextPage || locked}
                    onClick={() => void sources.fetchNextPage()}
                  >
                    Load remaining sources
                  </Button>
                ) : null}
                {items.length > 200 ? (
                  <p role="alert">This release exceeds the 200-source grouping limit.</p>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="grouping-reason">Reason for this change</Label>
              <Textarea
                id="grouping-reason"
                value={reason}
                maxLength={4000}
                disabled={locked}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
            <div className="grid gap-2 rounded-md border p-3 text-sm">
              <p>
                {kind === 'merge'
                  ? `This release stays in place. The other release becomes a historical reference, and all ${items.length} of its source objects move here.`
                  : `${selected.length} selected source objects move to the new release. Unselected sources stay here.`}
              </p>
              <p>
                Saved facts, campaigns, drafts and approvals keep their original release. Review the
                facts on each resulting release before qualification.
              </p>
            </div>
            <Button
              disabled={
                locked ||
                !choicesReady ||
                !targetEligible ||
                !reason.trim() ||
                (kind === 'split' && (!selected.length || !title.trim() || !benefit.trim()))
              }
              onClick={submit}
            >
              {busy
                ? 'Saving grouping…'
                : kind === 'merge'
                  ? 'Merge into this release'
                  : 'Create separate release'}
            </Button>
          </>
        )}
        <Button variant="outline" disabled={busy || Boolean(pending)} onClick={close}>
          {saved.length ? 'Done' : 'Cancel grouping'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/** Group candidates without losing their original facts, work or deep links. */
export function ReleaseGrouping({
  data,
  scope,
  canEdit,
  onGrouped,
  onEditingChange,
}: {
  data: ReleaseQualification
  scope: Scope
  canEdit: boolean
  onGrouped: () => Promise<void>
  onEditingChange: (editing: boolean) => void
}) {
  const [mode, setMode] = useState<'merge' | 'split' | 'history' | null>(null)
  useEffect(() => {
    onEditingChange(mode === 'merge' || mode === 'split')
    return () => onEditingChange(false)
  }, [mode, onEditingChange])
  const eligible = data.enabled && data.canonicalState === 'ACTIVE' && !data.firstQualifiedAt
  return (
    <Section
      title="Release grouping"
      description="Keep one customer change together, or separate sources that need independent rollouts."
    >
      <div className="flex flex-wrap gap-2">
        {eligible ? (
          <>
            <Button variant="outline" disabled={!canEdit} onClick={() => setMode('merge')}>
              Merge another release
            </Button>
            <Button variant="outline" disabled={!canEdit} onClick={() => setMode('split')}>
              Split sources
            </Button>
          </>
        ) : null}
        <Button variant="outline" onClick={() => setMode('history')}>
          Merge and split history
        </Button>
      </div>
      {eligible && !canEdit ? (
        <p className="text-sm">
          Creator access and saved facts and source selections are required to group releases.
        </p>
      ) : null}
      {data.firstQualifiedAt ? (
        <p className="text-sm">This release has been qualified. Its identity stays fixed.</p>
      ) : null}
      {mode === 'history' ? (
        <GroupingHistory releaseId={data.releaseId} scope={scope} onClose={() => setMode(null)} />
      ) : mode ? (
        <GroupingDialog
          kind={mode}
          data={data}
          scope={scope}
          canEdit={canEdit}
          onGrouped={onGrouped}
          onClose={() => setMode(null)}
        />
      ) : null}
    </Section>
  )
}

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  releaseSourcePageSchema,
  releaseSourceHistorySchema,
  releaseSourceSelectionSchema,
  selectReleaseSourcesSchema,
  releaseQualificationSchema,
  type ReleaseSource,
  type SelectReleaseSourcesInput,
  type QualificationSource,
} from 'screenshot-studio-backend-sdk'
import { Section } from '@/components/platform-ui'
import { RECENT_WORK_KEY } from '@/components/platform-hub/work'
import { WorkspaceActivity } from '@/components/workspace/WorkspaceActivity'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { releaseChoicesSchema } from '@/lib/api/contracts/releases'
import { SettingsRequestError, settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

type Scope = { userId: string; workspaceId: string }
type Observation = QualificationSource['observation']
type Choice = { source: ReleaseSource; observation: Observation }
type Pending = { key: string; body: SelectReleaseSourcesInput }

/** Keep the inbox's existing release list current after source selection. */
export function ReleaseSourceInbox(props: { scope: Scope; enabled: boolean; canEdit: boolean }) {
  const [revision, setRevision] = useState(0)
  return (
    <>
      <ReleaseSourceSelection
        {...props}
        onSelected={async () => setRevision((value) => value + 1)}
      />
      <WorkspaceActivity key={revision} sections={['releases']} />
    </>
  )
}

/** Render the retained provider facts used in history and qualification. */
export function ReleaseSourceSnapshot({ observation }: { observation: Observation }) {
  return (
    <div className="grid min-w-0 gap-2 break-words text-sm">
      <p className="font-medium">{observation.snapshot.title || 'Untitled source observation'}</p>
      <p className="text-muted-foreground">
        {observation.sourceUpdatedAt
          ? `Provider updated ${new Date(observation.sourceUpdatedAt).toLocaleString()}`
          : 'Provider update time unknown'}
        {observation.origin === 'HISTORICAL' ? ' · Imported history' : ''}
      </p>
      {observation.snapshot.providerState ? <p>{observation.snapshot.providerState}</p> : null}
      {observation.snapshot.repositoryName ? (
        <p>Repository: {observation.snapshot.repositoryName}</p>
      ) : null}
      {observation.snapshot.commit ? (
        <p className="break-all">Commit: {observation.snapshot.commit}</p>
      ) : null}
      {observation.snapshot.environment ? (
        <p>Environment: {observation.snapshot.environment}</p>
      ) : null}
      {observation.snapshot.url ? (
        <a
          className="break-all underline"
          href={observation.snapshot.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open provider source (opens in a new tab)
        </a>
      ) : null}
      {observation.snapshot.notes ? (
        <Disclosure>
          <DisclosureTrigger>Provider notes</DisclosureTrigger>
          <DisclosureContent className="whitespace-pre-wrap break-words pt-2">
            {observation.snapshot.notes}
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </div>
  )
}

function SourceHistory({
  source,
  scope,
  canSelect,
  onSelect,
  onClose,
}: {
  source: ReleaseSource
  scope: Scope
  canSelect: boolean
  onSelect: (choice: Choice) => void
  onClose: () => void
}) {
  const query = useInfiniteQuery({
    queryKey: ['release-source-history', scope.workspaceId, scope.userId, source.id],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `/api/v1/release-sources/${encodeURIComponent(source.id)}/observations${pageParam ? `?cursor=${pageParam}` : ''}`,
        releaseSourceHistorySchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor,
    refetchOnWindowFocus: false,
    retry: false,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Source observation history</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Choose the exact snapshot to use. Selecting evidence does not confirm its accuracy or
          qualify the release.
        </p>
        {query.isPending ? <p role="status">Loading source history…</p> : null}
        {query.isError ? (
          <div role="alert">
            <p>{settingsErrorMessage(query.error)}</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry source history
            </Button>
          </div>
        ) : null}
        {query.data?.pages.flatMap((page) =>
          page.items.map((observation) => (
            <article
              key={observation.id}
              aria-label={`Observation ${observation.sequence}`}
              className="grid min-w-0 gap-3 rounded-md border p-3"
            >
              <p className="text-sm">
                Received {new Date(observation.receivedAt).toLocaleString()}
                {source.selected?.id === observation.id ? ' · Selected snapshot' : ''}
              </p>
              <ReleaseSourceSnapshot observation={observation} />
              {canSelect ? (
                <Button
                  variant="outline"
                  disabled={!page.source.available}
                  onClick={() => {
                    onSelect({ source: page.source, observation })
                    onClose()
                  }}
                >
                  Use this snapshot
                </Button>
              ) : null}
            </article>
          ))
        )}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Older observations
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Close history
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/** The inbox and release detail share exact-snapshot selection and retry behavior. */
export function ReleaseSourceSelection({
  scope,
  enabled,
  canEdit,
  release,
  onSelected,
  onEditingChange,
}: {
  scope: Scope
  enabled: boolean
  canEdit: boolean
  release?: { id: string; revision: string }
  onSelected?: () => Promise<void>
  onEditingChange?: (editing: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState<Record<string, Choice>>({})
  const [mode, setMode] = useState('new')
  const [title, setTitle] = useState('')
  const [benefit, setBenefit] = useState('')
  const [search, setSearch] = useState('')
  const [submittedSearch, setSubmittedSearch] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedRelease, setSavedRelease] = useState<string | null>(null)
  const [associatedRelease, setAssociatedRelease] = useState<string | null>(null)
  const [history, setHistory] = useState<ReleaseSource | null>(null)
  const choices = Object.values(picked)
  const dirty =
    choices.length > 0 || title.trim().length > 0 || benefit.trim().length > 0 || pending !== null
  useUnsavedSettings(dirty)
  useEffect(() => {
    onEditingChange?.(dirty || busy)
    return () => onEditingChange?.(false)
  }, [dirty, busy, onEditingChange])
  const locked = !enabled || !canEdit || busy || pending !== null || stale
  const query = useInfiniteQuery({
    queryKey: ['release-sources', scope.workspaceId, scope.userId, release?.id ?? 'inbox'],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams()
      if (release) params.set('releaseId', release.id)
      if (pageParam) params.set('cursor', pageParam)
      return settingsRequest(`/api/v1/release-sources?${params}`, releaseSourcePageSchema, {
        scope,
        signal,
      })
    },
    getNextPageParam: (page) => page.nextCursor,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const targets = useQuery({
    queryKey: ['source-selection-releases', scope.workspaceId, scope.userId, submittedSearch],
    enabled: !release && mode === 'existing',
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
    queryKey: ['source-selection-target', scope.workspaceId, scope.userId, target],
    enabled: !release && mode === 'existing' && target !== null,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: ({ signal }) =>
      settingsRequest(
        `/api/v1/releases/${encodeURIComponent(target ?? '')}/qualification`,
        releaseQualificationSchema,
        { scope, signal }
      ),
  })
  const choose = (choice: Choice) => {
    setPicked((current) => ({ ...current, [choice.source.id]: choice }))
    setSavedRelease(null)
  }
  const reload = async () => {
    if (
      busy ||
      pending ||
      (dirty &&
        !window.confirm('Discard this unsaved source selection and load the latest evidence?'))
    )
      return
    setBusy(true)
    setError(null)
    try {
      const refreshed = await query.refetch()
      if (refreshed.isError) throw refreshed.error
      if (canEdit) await onSelected?.()
      if (!release && target) {
        const facts = await targetFacts.refetch()
        if (facts.isError) throw facts.error
      }
      setPicked({})
      setTitle('')
      setBenefit('')
      setStale(false)
      setAssociatedRelease(null)
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
    setSavedRelease(null)
    let committed = false
    try {
      const result = await settingsRequest(
        '/api/v1/release-sources/selections',
        releaseSourceSelectionSchema,
        { scope, method: 'POST', body: command.body, commandKey: command.key }
      )
      committed = true
      void queryClient.invalidateQueries({ queryKey: RECENT_WORK_KEY })
      void queryClient.invalidateQueries({ queryKey: ['shell-search'] })
      void queryClient.invalidateQueries({
        queryKey: ['source-selection-target', scope.workspaceId, scope.userId],
      })
      await onSelected?.()
      setPending(null)
      setPicked({})
      setTitle('')
      setBenefit('')
      setSavedRelease(result.releaseId)
      await query.refetch()
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
        if (failure.details && 'releaseId' in failure.details)
          setAssociatedRelease(failure.details.releaseId)
      }
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (locked) return
    const existing =
      release ??
      (mode === 'existing' && target && targetFacts.data
        ? { id: target, revision: targetFacts.data.revision }
        : null)
    if (!release && mode === 'existing' && !existing) {
      setError('Choose an existing release and wait for its current facts to load.')
      return
    }
    const parsed = selectReleaseSourcesSchema.safeParse({
      releaseId: existing?.id ?? null,
      newRelease: existing ? null : { title: title.trim(), benefitStatement: benefit.trim() },
      expectedRevision: existing?.revision ?? '0',
      sources: choices.map(({ source, observation }) => ({
        bindingId: source.id,
        observationId: observation.id,
        expectedSequence: source.sequence,
      })),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the source selection.')
      return
    }
    void send({ key: crypto.randomUUID(), body: parsed.data })
  }
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  if (!enabled && query.isSuccess && items.length === 0) return null
  return (
    <Section
      title={release ? 'Selected source evidence' : 'Source suggestions'}
      description="Review PRs and deployments, then choose which snapshots belong to a release. Provider events do not make a human qualification decision."
    >
      {!enabled ? (
        <p>Source selection is disabled. Retained evidence is still available.</p>
      ) : !canEdit ? (
        <p>
          Your role can read sources. Creator access and saved release facts are required to change
          the selection.
        </p>
      ) : null}
      {query.isPending ? <p role="status">Loading source evidence…</p> : null}
      {query.isError ? (
        <p role="alert">Source evidence could not load. {settingsErrorMessage(query.error)}</p>
      ) : null}
      {!query.isPending && !query.isError && !items.length ? (
        <p>
          {release
            ? 'No provider snapshots selected for this release. Choose sources in the Release inbox, or continue with a source link, file or human brief.'
            : 'No new source evidence to review. Connect a repository or deployment source, or continue with an existing release below.'}
        </p>
      ) : null}
      {release ? (
        <Link className="underline" href="/campaigns/releases">
          Open Release inbox to add sources
        </Link>
      ) : (
        <Link className="underline" href="/workflows/sources">
          Manage source connections
        </Link>
      )}
      <ul className="grid min-w-0 gap-3">
        {items.map((source) => (
          <li
            key={source.id}
            className="grid min-w-0 gap-3 rounded-md border p-3"
            data-testid="release-source-card"
          >
            <div className="flex items-start gap-3">
              <Checkbox
                id={`choose-source-${source.id}`}
                checked={Boolean(picked[source.id])}
                disabled={
                  locked ||
                  !source.available ||
                  !source.current ||
                  (!picked[source.id] && choices.length >= 200)
                }
                onCheckedChange={(checked) => {
                  if (checked === true && source.current)
                    choose({ source, observation: source.current })
                  else
                    setPicked((current) => {
                      const next = { ...current }
                      delete next[source.id]
                      return next
                    })
                }}
              />
              <Label className="min-w-0 break-words" htmlFor={`choose-source-${source.id}`}>
                {source.current?.snapshot.title || 'Source observation'}
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              {source.sourceName} ·{' '}
              {source.kind === 'PULL_REQUEST' ? `PR #${source.providerObjectId}` : 'Deployment'}
            </p>
            {!source.available ? (
              <p role="status">Source unavailable. Reconnect it before changing the selection.</p>
            ) : null}
            {source.needsResolution ? (
              <p role="status">
                Conflicting or unordered provider evidence. Review the history and explicitly choose
                the snapshot to use.
              </p>
            ) : source.selected && source.selectionNeedsReview ? (
              <p role="status">
                New evidence arrived after the selected snapshot. Review it before qualifying.
              </p>
            ) : null}
            {source.selected ? (
              <p className="text-sm">
                Saved snapshot: {source.selected.snapshot.title || 'Untitled observation'}
              </p>
            ) : null}
            {picked[source.id] ? (
              <p role="status" className="text-sm">
                Selected to save:{' '}
                {picked[source.id].observation.snapshot.title || 'Untitled observation'}
              </p>
            ) : null}
            {source.canonicalReleaseId && source.canonicalReleaseId !== release?.id ? (
              <Link className="underline" href={`/releases/${source.canonicalReleaseId}`}>
                Open associated release
              </Link>
            ) : null}
            <Button
              className="justify-self-start"
              variant="outline"
              disabled={busy}
              onClick={() => setHistory(source)}
            >
              View source history
            </Button>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={busy || query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          More source evidence
        </Button>
      ) : null}
      {canEdit && enabled && dirty ? (
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <p role="status">
            {choices.length} source {choices.length === 1 ? 'object' : 'objects'} selected
          </p>
          {!release ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="source-release-target">Use these sources for</Label>
                <Select value={mode} onValueChange={setMode} disabled={locked}>
                  <SelectTrigger id="source-release-target">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">New release</SelectItem>
                    <SelectItem value="existing">Existing release</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {mode === 'new' ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="source-release-title">Release title</Label>
                    <Input
                      id="source-release-title"
                      value={title}
                      maxLength={160}
                      disabled={locked}
                      onChange={(event) => setTitle(event.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="source-release-benefit">What changed for users?</Label>
                    <Textarea
                      id="source-release-benefit"
                      value={benefit}
                      maxLength={500}
                      disabled={locked}
                      onChange={(event) => setBenefit(event.target.value)}
                      required
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="source-release-search">Find a release by title</Label>
                    <div className="flex gap-2">
                      <Input
                        id="source-release-search"
                        value={search}
                        maxLength={200}
                        disabled={locked}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={() => {
                          setSubmittedSearch(search.trim())
                          setTarget(null)
                        }}
                      >
                        Search releases
                      </Button>
                    </div>
                  </div>
                  {targets.isPending ? (
                    <p role="status">Loading releases…</p>
                  ) : targets.isError ? (
                    <div role="alert">
                      <p>{settingsErrorMessage(targets.error)}</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void targets.refetch()}
                      >
                        Retry releases
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="grid gap-2">
                        <Label htmlFor="source-existing-release">Existing release</Label>
                        <Combobox
                          id="source-existing-release"
                          value={target}
                          onValueChange={setTarget}
                          disabled={locked}
                          options={(targets.data?.releases ?? [])
                            .filter(
                              (item) => item.status !== 'ARCHIVED' && item.status !== 'CANCELLED'
                            )
                            .map((item) => ({ value: item.id, label: item.title }))}
                        />
                      </div>
                      {targets.data?.releases.length === 50 ? (
                        <p>
                          Showing 50 matching releases. Refine the title search to find an older
                          release.
                        </p>
                      ) : null}
                    </>
                  )}
                  {target && targetFacts.isPending ? (
                    <p role="status">Loading the release revision…</p>
                  ) : null}
                  {targetFacts.isError ? (
                    <div role="alert">
                      <p>{settingsErrorMessage(targetFacts.error)}</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void targetFacts.refetch()}
                      >
                        Retry release facts
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </>
          ) : null}
          <Button
            className="justify-self-start"
            type="submit"
            disabled={
              locked ||
              choices.length === 0 ||
              (mode === 'existing' && !release && (!target || !targetFacts.data))
            }
          >
            Save source selection
          </Button>
        </form>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {associatedRelease ? (
            <Link className="underline" href={`/releases/${associatedRelease}`}>
              Open the existing release
            </Link>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <div className="grid gap-2">
          <p>Keep this form open. Retry the original request to recover its saved result.</p>
          <Button disabled={busy} variant="outline" onClick={() => void send(pending)}>
            Retry source selection
          </Button>
        </div>
      ) : (
        <Button
          className="justify-self-start"
          variant="outline"
          disabled={busy || query.isFetching}
          onClick={() => void reload()}
        >
          {dirty ? 'Discard selection and load latest' : 'Load latest sources'}
        </Button>
      )}
      {savedRelease ? (
        <p role="status">
          Sources saved.{' '}
          <Link className="underline" href={`/releases/${savedRelease}`}>
            Review release facts next
          </Link>
          .
        </p>
      ) : null}
      {history ? (
        <SourceHistory
          source={history}
          scope={scope}
          canSelect={!locked && (Boolean(picked[history.id]) || choices.length < 200)}
          onSelect={choose}
          onClose={() => setHistory(null)}
        />
      ) : null}
    </Section>
  )
}

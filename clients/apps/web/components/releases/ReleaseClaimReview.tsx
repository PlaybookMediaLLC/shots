'use client'

import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import {
  createReleaseEvidenceSchema,
  importReleaseSpecClaimsSchema,
  saveReleaseClaimSchema,
  setClaimSupportsSchema,
  verifyReleaseClaimSchema,
  changeEvidenceAccessSchema,
  readinessMutationSchema,
  releaseClaimsPageSchema,
  releaseEvidencePageSchema,
  type ReleaseClaim,
  type ReleaseEvidence,
  type ReleaseQualification,
  type SetClaimSupportsInput,
} from 'screenshot-studio-backend-sdk'
import { Section, Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { DatePicker } from '@/components/ui/date-picker'
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
import { TimePicker } from '@/components/ui/time-picker'
import { MediaThumb } from '@/components/write/composer/media-thumb'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { settingsRequest, settingsErrorMessage, SettingsRequestError } from '@/lib/settings/client'
import { ReleaseEvidencePicker } from './ReleaseEvidencePicker'

type Command = { path: string; body: unknown; key: string }
type Support = SetClaimSupportsInput['supports'][number]
const qualifierFields = ['audience', 'availability', 'eligibility', 'limitations'] as const
const reviewLabels = {
  SUPPORTED: 'Supported',
  CONTRADICTED: 'Contradicted',
  UNRESOLVED: 'Needs review',
  WITHDRAWN: 'Withdrawn',
}
const sourceLabel = (item: ReleaseEvidence) =>
  item.text?.split('\n')[0].slice(0, 90) ||
  `${item.format === 'IMAGE' ? 'Screenshot' : 'Source'} · ${new Date(item.observedAt).toLocaleDateString()}`

/** Manual factual review shares the release revision with qualification and kits. */
export function ReleaseClaimReview({
  releaseId,
  workspaceId,
  userId,
  qualification,
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
  canEdit: boolean
  canDecide: boolean
  disabled: boolean
  onRevision: (revision: string) => void
  onReload: (qualification: ReleaseQualification) => void
  onEditing: (editing: boolean) => void
}) {
  const base = `/api/v1/releases/${encodeURIComponent(releaseId)}`
  const scope = useMemo(() => ({ workspaceId, userId }), [workspaceId, userId])
  const [mode, setMode] = useState<'view' | 'claim' | 'evidence' | 'review'>('view')
  const [selected, setSelected] = useState<ReleaseClaim | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<Command | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [accessDraft, setAccessDraft] = useState<string | null>(null)
  const claims = useInfiniteQuery({
    queryKey: ['release-claims', workspaceId, userId, releaseId, qualification.revision],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `${base}/claims${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        releaseClaimsPageSchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const evidence = useInfiniteQuery({
    queryKey: ['release-evidence', workspaceId, userId, releaseId, qualification.revision],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      settingsRequest(
        `${base}/evidence${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        releaseEvidencePageSchema,
        { scope, signal }
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const allClaims = claims.data?.pages.flatMap((page) => page.items) ?? []
  const allEvidence = evidence.data?.pages.flatMap((page) => page.items) ?? []
  const writable =
    qualification.enabled &&
    qualification.canonicalState === 'ACTIVE' &&
    !disabled &&
    !stale &&
    !busy &&
    !pending &&
    !claims.isPending &&
    !evidence.isPending &&
    !claims.isError &&
    !evidence.isError
  const reviewer = canDecide && qualification.current?.facts.factReviewerUserId === userId
  useUnsavedSettings(dirty || pending !== null)
  useEffect(() => {
    onEditing(dirty || mode !== 'view' || pending !== null)
    return () => onEditing(false)
  }, [dirty, mode, pending, onEditing])

  const send = async (command: Command): Promise<boolean> => {
    if (busy) return false
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
      setPending(null)
      setMode('view')
      setAccessDraft(null)
      setSelected(null)
      setDirty(false)
      setMessage('Saved. The recorded version and its review history are retained.')
      return true
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
      return false
    } finally {
      setBusy(false)
    }
  }
  const run = (suffix: string, body: unknown) =>
    send({ path: `${base}/${suffix}`, body, key: crypto.randomUUID() })
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    }
  }
  const close = () => {
    if (pending || busy || (dirty && !window.confirm('Discard the unsaved review changes?'))) return
    setMode('view')
    setAccessDraft(null)
    setSelected(null)
    setDirty(false)
    setError(null)
  }
  const reload = async () => {
    if (
      pending ||
      busy ||
      (dirty && !window.confirm('Discard unsaved changes and reload the current release?'))
    )
      return
    setDirty(false)
    setMode('view')
    setAccessDraft(null)
    setSelected(null)
    setStale(false)
    const { releaseQualificationSchema } = await import('screenshot-studio-backend-sdk')
    const current = await settingsRequest(`${base}/qualification`, releaseQualificationSchema, {
      scope,
    })
    onReload(current)
    await Promise.all([claims.refetch(), evidence.refetch()])
  }
  return (
    <Section
      title="Claims and evidence"
      description="Review exact product facts against retained passages or screenshots. A citation alone does not verify a claim."
    >
      <div className="grid gap-4">
        {message ? <p role="status">{message}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {stale ? (
          <p role="status">
            This release or its evidence changed. Your unsaved work is still here. Reload before
            making another decision.
          </p>
        ) : null}
        {pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <p>
              The result is not confirmed. Retry this same request to retrieve its original result.
            </p>
            <Button disabled={busy} onClick={() => void send(pending)}>
              Retry saved request
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!writable || !canEdit || mode !== 'view' || dirty}
            onClick={() => {
              setSelected(null)
              setMode('claim')
            }}
          >
            Add claim
          </Button>
          <Button
            variant="outline"
            disabled={!writable || !canEdit || mode !== 'view' || dirty}
            onClick={() => setMode('evidence')}
          >
            Add evidence
          </Button>
          <Button
            variant="ghost"
            disabled={busy || Boolean(pending)}
            onClick={() => void attempt(reload)}
          >
            Reload review
          </Button>
          {mode !== 'view' ? (
            <Button variant="ghost" disabled={busy || Boolean(pending)} onClick={close}>
              Close editor
            </Button>
          ) : null}
        </div>
        {claims.isPending || evidence.isPending ? (
          <p role="status">Loading claims and evidence…</p>
        ) : null}
        {claims.isError || evidence.isError ? (
          <div role="alert">
            <p>Review records could not load. No decision can be made until they are available.</p>
            <Button variant="outline" onClick={() => void attempt(reload)}>
              Retry review records
            </Button>
          </div>
        ) : null}
        {mode === 'claim' ? (
          <form
            className="grid gap-3 rounded-lg border p-4"
            onChange={() => setDirty(true)}
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void attempt(() =>
                run(
                  'claims',
                  saveReleaseClaimSchema.parse({
                    expectedRevision: qualification.revision,
                    claimId: selected?.id ?? null,
                    expectedClaimVersionId: selected?.versionId ?? null,
                    text: form.get('text'),
                    origin: form.get('origin'),
                    qualifiers: Object.fromEntries(
                      qualifierFields.map((field) => [field, form.get(field)])
                    ),
                  })
                )
              )
            }}
          >
            <fieldset className="grid gap-3" disabled={!writable || !canEdit}>
              <legend className="mb-3 font-medium">
                {selected ? 'Edit claim as a new version' : 'New product claim'}
              </legend>
              <Label htmlFor="claim-text">Exact factual claim</Label>
              <Textarea
                id="claim-text"
                name="text"
                required
                maxLength={4096}
                defaultValue={selected?.text ?? ''}
              />
              {qualifierFields.map((field) => (
                <div className="grid gap-1" key={field}>
                  <Label htmlFor={`claim-${field}`}>
                    {field[0].toUpperCase() + field.slice(1)}
                  </Label>
                  <Textarea
                    id={`claim-${field}`}
                    name={field}
                    maxLength={4096}
                    defaultValue={selected?.qualifiers[field] ?? ''}
                  />
                </div>
              ))}
              <Label htmlFor="claim-origin">Drafted by</Label>
              <Select name="origin" defaultValue={selected?.origin === 'AI' ? 'AI' : 'HUMAN'}>
                <SelectTrigger id="claim-origin">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="HUMAN">A person</SelectItem>
                  <SelectItem value="AI">AI assistance</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                Incomplete conditions can be saved. Support requires audience, availability,
                eligibility and limitations, including when there are none.
              </p>
              <Button type="submit">Save claim for review</Button>
            </fieldset>
          </form>
        ) : null}
        {mode === 'evidence' ? (
          <EvidenceForm
            qualification={qualification}
            disabled={!writable || !canEdit}
            onDirty={() => setDirty(true)}
            onSubmit={(body) =>
              attempt(() => run('evidence', createReleaseEvidenceSchema.parse(body)))
            }
          />
        ) : null}
        {mode === 'review' && selected ? (
          <ClaimReviewForm
            key={selected.versionId}
            claim={selected}
            evidence={allEvidence}
            revision={qualification.revision}
            canEdit={writable && canEdit}
            canDecide={writable && reviewer}
            onDirty={() => setDirty(true)}
            onSubmit={(suffix, body) => attempt(() => run(suffix, body()))}
          />
        ) : null}
        {!claims.isPending && !allClaims.length ? (
          <p>
            No claims have been added. Add a product fact or save a release spec to start review.
          </p>
        ) : null}
        <ul className="grid gap-3">
          {allClaims.map((claim) => (
            <li className="grid gap-2 rounded-lg border p-4" key={claim.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill
                  tone={
                    claim.state === 'SUPPORTED'
                      ? 'green'
                      : claim.state === 'CONTRADICTED'
                        ? 'red'
                        : 'gray'
                  }
                >
                  {reviewLabels[claim.state]}
                </Pill>
                <span className="text-sm text-muted-foreground">
                  Version {claim.version} ·{' '}
                  {claim.origin === 'AI' ? 'AI drafted' : 'Human authored'}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words">{claim.text}</p>
              {claim.blockers.length ? (
                <p className="text-sm text-muted-foreground">
                  {claim.blockers
                    .map((reason) => reason.toLowerCase().replaceAll('_', ' '))
                    .join(' · ')}
                </p>
              ) : null}
              {claim.decision ? (
                <p className="text-sm">
                  Last decision: {reviewLabels[claim.decision.decision]} ·{' '}
                  {new Date(claim.decision.createdAt).toLocaleString()} · {claim.decision.reason}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={mode !== 'view' || dirty || busy || Boolean(pending)}
                  onClick={() => {
                    setSelected(claim)
                    setMode('review')
                  }}
                >
                  Review supporting evidence
                </Button>
                <Button
                  variant="ghost"
                  disabled={!writable || !canEdit || mode !== 'view' || dirty}
                  onClick={() => {
                    setSelected(claim)
                    setMode('claim')
                  }}
                >
                  Edit claim
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {claims.hasNextPage ? (
          <Button
            variant="outline"
            disabled={claims.isFetchingNextPage}
            onClick={() => void claims.fetchNextPage()}
          >
            More claims
          </Button>
        ) : null}
        {claims.data?.pages[0]?.importProgress ? (
          <div className="grid gap-2">
            <p className="text-sm">
              Legacy specs: {claims.data.pages[0].importProgress.imported} imported,{' '}
              {claims.data.pages[0].importProgress.skipped} already mapped,{' '}
              {claims.data.pages[0].importProgress.invalid} invalid. Historical approvals stay
              unchanged; imported claims require factual review.
            </p>
            {!claims.data.pages[0].importProgress.done && canEdit ? (
              <Button
                variant="outline"
                disabled={!writable || mode !== 'view' || dirty}
                onClick={() =>
                  void attempt(() =>
                    run(
                      'claims/imports',
                      importReleaseSpecClaimsSchema.parse({
                        expectedRevision: qualification.revision,
                      })
                    )
                  )
                }
              >
                Import next batch of legacy specs
              </Button>
            ) : null}
            {claims.data.pages[0].importProgress.invalidSpecIds.length ? (
              <p role="status">
                Invalid spec records in the last batch:{' '}
                {claims.data.pages[0].importProgress.invalidSpecIds.join(', ')}. Their source data
                was retained.
              </p>
            ) : null}
          </div>
        ) : null}
        <h3 className="font-medium">Retained evidence</h3>
        <ul className="grid gap-3">
          {allEvidence.map((item) => (
            <li className="grid gap-2 rounded-lg border p-4" key={item.id}>
              <EvidenceView item={item} />
              {(canEdit || reviewer) && item.available ? (
                <form
                  key={`${item.id}:${qualification.revision}`}
                  className="grid gap-2"
                  onChange={() => {
                    setDirty(true)
                    setAccessDraft(item.id)
                  }}
                  onSubmit={(event) => {
                    event.preventDefault()
                    const form = new FormData(event.currentTarget)
                    void attempt(() =>
                      run(
                        'evidence/access',
                        changeEvidenceAccessSchema.parse({
                          expectedRevision: qualification.revision,
                          evidenceVersionId: item.id,
                          expectedSourceSequence: item.sourceSequence,
                          action: form.get('action'),
                          audienceIds:
                            form.get('action') === 'CLEAR_FOR_AUDIENCE' && form.get('audience')
                              ? [form.get('audience')]
                              : [],
                          reason: form.get('reason'),
                        })
                      )
                    )
                  }}
                >
                  <fieldset
                    className="grid gap-2"
                    disabled={
                      !writable ||
                      mode !== 'view' ||
                      (accessDraft !== null && accessDraft !== item.id)
                    }
                  >
                    <Label htmlFor={`evidence-action-${item.id}`}>
                      Access or retention decision
                    </Label>
                    <Select
                      name="action"
                      defaultValue={canEdit ? 'WITHDRAW' : 'CLEAR_FOR_AUDIENCE'}
                    >
                      <SelectTrigger id={`evidence-action-${item.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {canEdit ? (
                          <SelectItem value="WITHDRAW">Withdraw from factual use</SelectItem>
                        ) : null}
                        {canEdit && !item.assetId ? (
                          <SelectItem value="TOMBSTONE">Erase retained text</SelectItem>
                        ) : null}
                        {reviewer ? (
                          <>
                            <SelectItem value="CLEAR_FOR_AUDIENCE">
                              Clear for an audience
                            </SelectItem>
                            <SelectItem value="REVOKE_CLEARANCE">
                              Revoke audience clearance
                            </SelectItem>
                          </>
                        ) : null}
                      </SelectContent>
                    </Select>
                    {reviewer ? (
                      <>
                        <Label htmlFor={`evidence-audience-${item.id}`}>
                          Audience (only for clearance)
                        </Label>
                        <Select name="audience">
                          <SelectTrigger id={`evidence-audience-${item.id}`}>
                            <SelectValue placeholder="No audience" />
                          </SelectTrigger>
                          <SelectContent>
                            {qualification.current?.facts.requirements.map((audience) => (
                              <SelectItem key={audience.id} value={audience.id}>
                                {audience.label ?? audience.kind.replaceAll('_', ' ')}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </>
                    ) : null}
                    <Label htmlFor={`evidence-reason-${item.id}`}>Reason</Label>
                    <Textarea
                      id={`evidence-reason-${item.id}`}
                      name="reason"
                      required
                      maxLength={8192}
                    />
                    <Button type="submit" variant="outline" disabled={mode !== 'view'}>
                      Record evidence decision
                    </Button>
                  </fieldset>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {evidence.hasNextPage ? (
          <Button
            variant="outline"
            disabled={evidence.isFetchingNextPage}
            onClick={() => void evidence.fetchNextPage()}
          >
            More evidence
          </Button>
        ) : null}
      </div>
    </Section>
  )
}

function EvidenceView({ item }: { item: ReleaseEvidence }) {
  return (
    <div className="grid gap-2">
      <p className="font-medium">
        {item.kind === 'ATTESTATION'
          ? item.confirmedAt
            ? 'Named human attestation'
            : 'Unconfirmed attestation draft'
          : item.format === 'IMAGE'
            ? 'Product screenshot'
            : 'Retained source'}{' '}
        · version {item.version}
      </p>
      <p className="text-sm text-muted-foreground">
        {item.origin} · observed {new Date(item.observedAt).toLocaleString()} ·{' '}
        {item.available
          ? item.current
            ? 'Current snapshot'
            : 'Source changed since capture'
          : 'Unavailable for reuse'}{' '}
        · {item.accessClass.replaceAll('_', ' ').toLowerCase()}
      </p>
      {item.available && item.text ? (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-sans text-sm whitespace-pre-wrap break-words">
          {item.text}
        </pre>
      ) : null}
      {item.available && item.assetId ? (
        <MediaThumb
          assetId={item.redactionAssetId ?? item.assetId}
          className="max-h-64 w-full object-contain"
          video={false}
        />
      ) : null}
      {item.sourceUrl ? (
        <a
          className="text-sm underline break-all"
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open original source (new tab)
        </a>
      ) : null}
      {item.confirmedAt ? (
        <p className="text-sm">
          Confirmed by the author on {new Date(item.confirmedAt).toLocaleString()}. Scope:{' '}
          {item.attestationScope}. Limitations: {item.limitations}.
        </p>
      ) : null}
      {item.tombstonedAt ? (
        <p>Source content was erased. Its history cannot establish continued support.</p>
      ) : null}
    </div>
  )
}

function EvidenceForm({
  qualification,
  disabled,
  onDirty,
  onSubmit,
}: {
  qualification: ReleaseQualification
  disabled: boolean
  onDirty: () => void
  onSubmit: (body: unknown) => Promise<void>
}) {
  const [kind, setKind] = useState('TEXT')
  const [assetId, setAssetId] = useState<string | null>(null)
  const [picker, setPicker] = useState<'original' | 'redaction' | null>(null)
  const [redactionAssetId, setRedactionAssetId] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10))
  const [time, setTime] = useState(() => new Date().toISOString().slice(11, 16))
  const sources = qualification.current?.sources ?? []
  return (
    <form
      className="grid gap-3 rounded-lg border p-4"
      onChange={onDirty}
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const source = sources.find((item) => item.bindingId === sourceId)
        void onSubmit({
          expectedRevision: qualification.revision,
          kind,
          origin: kind === 'RELEASE_SOURCE' ? 'PROVIDER' : form.get('origin'),
          text: form.get('text') ?? '',
          purpose: form.get('purpose'),
          sourceUrl: form.get('url') || null,
          observedAt: kind === 'RELEASE_SOURCE' ? null : `${day}T${time}:00Z`,
          attestationScope: form.get('scope') ?? '',
          limitations: form.get('limitations') ?? '',
          confirmAttestation: form.get('confirm') === 'on',
          assetId: kind === 'ASSET' ? assetId : null,
          redactionAssetId: kind === 'ASSET' ? redactionAssetId : null,
          sourceBindingId: source?.bindingId ?? null,
          observationId: source?.observation.id ?? null,
        })
      }}
    >
      <fieldset className="grid gap-3" disabled={disabled}>
        <legend className="mb-3 font-medium">Add reviewable evidence</legend>
        <Label htmlFor="evidence-kind">Source type</Label>
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value)
            setSourceId('')
            onDirty()
          }}
        >
          <SelectTrigger id="evidence-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TEXT">Retained text</SelectItem>
            <SelectItem value="ATTESTATION">My dated attestation</SelectItem>
            <SelectItem value="ASSET">Owned screenshot</SelectItem>
            <SelectItem value="RELEASE_SOURCE">Selected provider observation</SelectItem>
          </SelectContent>
        </Select>
        {kind !== 'RELEASE_SOURCE' ? (
          <>
            <Label htmlFor="evidence-origin">Content origin</Label>
            <Select name="origin" defaultValue="HUMAN">
              <SelectTrigger id="evidence-origin">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HUMAN">Human supplied</SelectItem>
                <SelectItem value="AI">AI generated (unverified)</SelectItem>
              </SelectContent>
            </Select>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor="evidence-day">Observed date (UTC)</Label>
                <DatePicker
                  id="evidence-day"
                  value={day}
                  onChange={(value) => {
                    setDay(value)
                    onDirty()
                  }}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="evidence-time">Observed time (UTC)</Label>
                <TimePicker
                  id="evidence-time"
                  required
                  value={time}
                  onChange={(value) => {
                    setTime(value)
                    onDirty()
                  }}
                />
              </div>
            </div>
          </>
        ) : null}
        {kind === 'TEXT' || kind === 'ATTESTATION' ? (
          <>
            <Label htmlFor="evidence-text">Exact passage</Label>
            <Textarea id="evidence-text" name="text" required maxLength={262144} />
            <Label htmlFor="evidence-url">Source URL (optional)</Label>
            <Input id="evidence-url" name="url" type="url" maxLength={2000} />
          </>
        ) : null}
        {kind === 'ATTESTATION' ? (
          <>
            <Label htmlFor="evidence-scope">What I can attest to</Label>
            <Textarea id="evidence-scope" name="scope" required maxLength={8192} />
            <Label htmlFor="evidence-limitations">Limitations of my knowledge</Label>
            <Textarea id="evidence-limitations" name="limitations" required maxLength={8192} />
            <div className="flex gap-2">
              <Checkbox id="evidence-confirm" name="confirm" required />
              <Label htmlFor="evidence-confirm">
                I authored this attestation and confirm its date, scope and limitations.
              </Label>
            </div>
          </>
        ) : null}
        {kind === 'ASSET' ? (
          <>
            <Button type="button" variant="outline" onClick={() => setPicker('original')}>
              Choose a screenshot from Library
            </Button>
            {assetId ? (
              <>
                <Button type="button" variant="outline" onClick={() => setPicker('redaction')}>
                  Choose a reviewed redaction
                </Button>
                <p className="text-sm">
                  A redaction must be a Library derivative of this original, with the same
                  dimensions.
                </p>
                {redactionAssetId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setRedactionAssetId(null)
                      onDirty()
                    }}
                  >
                    Remove redaction
                  </Button>
                ) : null}
              </>
            ) : null}
            {assetId ? (
              <MediaThumb
                assetId={redactionAssetId ?? assetId}
                video={false}
                className="max-h-48 w-full object-contain"
              />
            ) : (
              <p>Choose an uploaded PNG, JPEG or WebP screenshot.</p>
            )}
          </>
        ) : null}
        {kind === 'RELEASE_SOURCE' ? (
          <>
            <Label htmlFor="evidence-provider">Selected source observation</Label>
            <Combobox
              id="evidence-provider"
              value={sourceId}
              options={sources.map((source) => ({
                value: source.bindingId,
                label: source.observation.snapshot.title,
              }))}
              onValueChange={(value) => {
                setSourceId(value)
                onDirty()
              }}
              placeholder="Choose a retained observation"
            />
            {!sources.length ? <p>Select a provider source in release facts first.</p> : null}
          </>
        ) : null}
        <Label htmlFor="evidence-purpose">Why this source is relevant</Label>
        <Textarea id="evidence-purpose" name="purpose" required maxLength={1000} />
        <p className="text-sm text-muted-foreground">
          New evidence is private. AI content cannot confirm itself. The assigned reviewer must
          decide whether the source supports a claim.
        </p>
        <Button type="submit">Retain evidence</Button>
      </fieldset>
      {picker ? (
        <ReleaseEvidencePicker
          selected={
            (picker === 'redaction' ? redactionAssetId : assetId)
              ? [picker === 'redaction' ? redactionAssetId! : assetId!]
              : []
          }
          limit={1}
          onClose={() => setPicker(null)}
          onSelect={(ids) => {
            if (ids.length === 1) {
              if (picker === 'redaction') setRedactionAssetId(ids[0])
              else {
                setAssetId(ids[0])
                setRedactionAssetId(null)
              }
              onDirty()
            }
          }}
        />
      ) : null}
    </form>
  )
}

function ClaimReviewForm({
  claim,
  evidence,
  revision,
  canEdit,
  canDecide,
  onDirty,
  onSubmit,
}: {
  claim: ReleaseClaim
  evidence: ReleaseEvidence[]
  revision: string
  canEdit: boolean
  canDecide: boolean
  onDirty: () => void
  onSubmit: (suffix: string, body: () => unknown) => Promise<void>
}) {
  const sources = [
    ...new Map([...claim.evidence, ...evidence].map((item) => [item.id, item])).values(),
  ]
  const [supports, setSupports] = useState<Support[]>(() =>
    claim.supports.map((pin) => ({
      evidenceVersionId: pin.evidenceVersionId,
      expectedSourceSequence:
        sources.find((item) => item.id === pin.evidenceVersionId)?.sourceSequence ??
        pin.sourceSequence,
      relation: pin.relation,
      selector: pin.selector,
      exclusionReason: pin.exclusionReason,
    }))
  )
  const [chosen, setChosen] = useState('')
  const [quote, setQuote] = useState('')
  const [region, setRegion] = useState({ x: 0, y: 0, width: 0, height: 0 })
  const [supportError, setSupportError] = useState<string | null>(null)
  const [edited, setEdited] = useState(false)
  const source = sources.find((item) => item.id === chosen)
  const change = (next: Support[]) => {
    setSupports(next)
    setEdited(true)
    onDirty()
  }
  const add = async () => {
    setSupportError(null)
    if (!source || !source.available || !source.current)
      return setSupportError('Choose current, readable evidence.')
    let selector: Support['selector']
    if (source.format === 'TEXT') {
      const text = source.text ?? ''
      const start = text.indexOf(quote)
      if (!quote || start < 0 || text.indexOf(quote, start + 1) >= 0)
        return setSupportError(
          'Paste an exact, unambiguous passage from this snapshot. Include more context if it appears twice.'
        )
      const bytes = new TextEncoder().encode(quote)
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const quoteSha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
      const startByte = new TextEncoder().encode(text.slice(0, start)).length
      selector = {
        kind: 'TEXT_SPAN',
        startByte,
        endByte: startByte + bytes.length,
        contextSha256: source.sha256,
        quoteSha256,
      }
    } else
      selector = {
        kind: 'IMAGE_REGION',
        ...region,
        contextSha256: source.sha256,
        ...(source.redactionAssetId ? { redactionId: source.redactionAssetId } : {}),
      }
    change([
      ...supports,
      {
        evidenceVersionId: source.id,
        expectedSourceSequence: source.sourceSequence,
        relation: 'SUPPORTS',
        selector,
        exclusionReason: '',
      },
    ])
    setChosen('')
    setQuote('')
  }
  return (
    <div className="grid gap-4 rounded-lg border p-4">
      <h3 className="font-medium">Review this exact claim</h3>
      <p className="whitespace-pre-wrap">{claim.text}</p>
      <dl className="grid gap-2">
        {qualifierFields.map((field) => (
          <div key={field}>
            <dt className="font-medium capitalize">{field}</dt>
            <dd>{claim.qualifiers[field] || 'Not confirmed'}</dd>
          </div>
        ))}
      </dl>
      <ul className="grid gap-4">
        {supports.map((support, index) => {
          const item = sources.find((value) => value.id === support.evidenceVersionId)
          const passage =
            item?.text && support.selector.kind === 'TEXT_SPAN'
              ? new TextDecoder().decode(
                  new TextEncoder()
                    .encode(item.text)
                    .slice(support.selector.startByte ?? 0, support.selector.endByte)
                )
              : null
          return (
            <li
              className="grid gap-2 rounded border p-3"
              key={`${support.evidenceVersionId}:${index}`}
            >
              {item ? <EvidenceView item={item} /> : <p>Evidence is unavailable.</p>}
              {passage ? (
                <blockquote className="border-l-2 pl-3 whitespace-pre-wrap">{passage}</blockquote>
              ) : null}
              <Label htmlFor={`support-relation-${index}`}>Relation to the claim</Label>
              <Select
                value={support.relation}
                disabled={!canEdit}
                onValueChange={(value) => {
                  if (value === 'SUPPORTS' || value === 'CONTRADICTS' || value === 'CONTEXT')
                    change(
                      supports.map((row, i) => (i === index ? { ...row, relation: value } : row))
                    )
                }}
              >
                <SelectTrigger id={`support-relation-${index}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SUPPORTS">Supports</SelectItem>
                  <SelectItem value="CONTRADICTS">Contradicts</SelectItem>
                  <SelectItem value="CONTEXT">Context only</SelectItem>
                </SelectContent>
              </Select>
              <Label htmlFor={`support-exclude-${index}`}>
                Reason to exclude this passage (optional)
              </Label>
              <Textarea
                id={`support-exclude-${index}`}
                value={support.exclusionReason}
                disabled={!canEdit}
                maxLength={8192}
                onChange={(event) =>
                  change(
                    supports.map((row, i) =>
                      i === index ? { ...row, exclusionReason: event.target.value } : row
                    )
                  )
                }
              />
              <Button
                variant="ghost"
                disabled={!canEdit || support.relation === 'CONTRADICTS'}
                onClick={() => change(supports.filter((_, i) => i !== index))}
              >
                Remove support
              </Button>
            </li>
          )
        })}
      </ul>
      {canEdit ? (
        <div className="grid gap-2">
          <Label htmlFor="claim-evidence-choice">Add a supporting or contradictory source</Label>
          <Combobox
            id="claim-evidence-choice"
            value={chosen}
            onValueChange={(id) => {
              setChosen(id)
              const next = sources.find((item) => item.id === id)
              setRegion({ x: 0, y: 0, width: next?.width ?? 0, height: next?.height ?? 0 })
            }}
            options={sources
              .filter((item) => item.available && item.current)
              .map((item) => ({ value: item.id, label: sourceLabel(item) }))}
            placeholder="Choose evidence"
          />
          {source ? (
            <>
              <EvidenceView item={source} />
              {source.format === 'TEXT' ? (
                <>
                  <Label htmlFor="support-quote">Exact passage to review</Label>
                  <Textarea
                    id="support-quote"
                    value={quote}
                    onChange={(event) => {
                      setQuote(event.target.value)
                      onDirty()
                    }}
                  />
                </>
              ) : (
                <div className="grid gap-2 sm:grid-cols-4">
                  {(['x', 'y', 'width', 'height'] as const).map((field) => (
                    <div key={field}>
                      <Label htmlFor={`support-region-${field}`}>{field}</Label>
                      <Input
                        id={`support-region-${field}`}
                        type="number"
                        min={field === 'width' || field === 'height' ? 1 : 0}
                        step={1}
                        value={region[field]}
                        onChange={(event) => {
                          setRegion({ ...region, [field]: Number(event.target.value) })
                          onDirty()
                        }}
                      />
                    </div>
                  ))}
                  <p className="text-sm sm:col-span-4">
                    Pixel region within the retained original. The full image is selected initially.
                  </p>
                </div>
              )}
              <Button
                variant="outline"
                disabled={supports.length >= 20}
                onClick={() =>
                  void add().catch((failure: unknown) =>
                    setSupportError(settingsErrorMessage(failure))
                  )
                }
              >
                Add to review set
              </Button>
            </>
          ) : null}
          {supportError ? <p role="alert">{supportError}</p> : null}
          <Button
            disabled={!edited}
            onClick={() =>
              void onSubmit(`claims/${encodeURIComponent(claim.id)}/support`, () =>
                setClaimSupportsSchema.parse({
                  expectedRevision: revision,
                  claimVersionId: claim.versionId,
                  supports,
                })
              )
            }
          >
            Save support set
          </Button>
        </div>
      ) : null}
      <form
        className="grid gap-2 border-t pt-4"
        onChange={onDirty}
        onSubmit={(event) => {
          event.preventDefault()
          const form = new FormData(event.currentTarget)
          void onSubmit(`claims/${encodeURIComponent(claim.id)}/decisions`, () =>
            verifyReleaseClaimSchema.parse({
              expectedRevision: revision,
              claimVersionId: claim.versionId,
              claimSha256: claim.sha256,
              supportSetId: claim.supportSetId,
              supportSha256: claim.supportSha256,
              decision: form.get('decision'),
              reason: form.get('reason'),
            })
          )
        }}
      >
        <fieldset className="grid gap-2" disabled={!canDecide || edited || !claim.supportSetId}>
          <legend className="mb-2 font-medium">Assigned human review</legend>
          <p className="text-sm">
            Confirm that the selected evidence supports the exact wording and all conditions. Saving
            a citation is not verification.
          </p>
          <Label htmlFor="claim-decision">Decision</Label>
          <Select name="decision" defaultValue="UNRESOLVED">
            <SelectTrigger id="claim-decision">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(reviewLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="claim-reason">Rationale</Label>
          <Textarea id="claim-reason" name="reason" required maxLength={8192} />
          <Button type="submit">Record factual decision</Button>
        </fieldset>
        {edited ? (
          <p>Save the changed support set, then review its exact saved version.</p>
        ) : !claim.supportSetId ? (
          <p>Save a support set before recording a decision.</p>
        ) : !canDecide ? (
          <p>Only the assigned fact reviewer can record a decision.</p>
        ) : null}
      </form>
    </div>
  )
}

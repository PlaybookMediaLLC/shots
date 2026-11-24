'use client'

import { useState } from 'react'
import {
  createQualificationSchema,
  decideQualificationSchema,
  qualificationDecisionSchema,
  qualificationResultSchema,
  qualificationRevisionSchema,
  releaseAudienceSchema,
  releaseMaterialSchema,
  releaseQualificationSchema,
  releaseRolloutSchema,
  type CreateQualificationInput,
  type DecideQualificationInput,
  type ReleaseFacts,
  type ReleaseQualification as Qualification,
  type QualificationRevision,
} from 'screenshot-studio-backend-sdk'
import { Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { DatePicker } from '@/components/ui/date-picker'
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
import { TimePicker } from '@/components/ui/time-picker'
import { useUnsavedSettings } from '@/components/settings/useUnsavedSettings'
import { SettingsRequestError, settingsErrorMessage, settingsRequest } from '@/lib/settings/client'
import { ReleaseEvidencePicker } from './ReleaseEvidencePicker'
import { ReleaseKitReview } from './ReleaseKitReview'
import { ReleaseClaimReview } from './ReleaseClaimReview'
import { ReleaseGrouping } from './ReleaseGrouping'
import { ReleaseSourceSelection, ReleaseSourceSnapshot } from './ReleaseSourceSelection'

type Member = { userId: string; name: string; role: string }
type Pending =
  | { key: string; kind: 'revisions'; body: CreateQualificationInput }
  | { key: string; kind: 'decisions'; body: DecideQualificationInput }
const labels = {
  UNKNOWN: 'Not confirmed',
  PLANNED: 'Planned',
  LIMITED: 'Limited rollout',
  GENERAL: 'Generally available',
  WITHDRAWN: 'Withdrawn',
  SALES: 'Sales',
  CUSTOMER_SUCCESS: 'Customer success',
  CUSTOMER: 'Customers',
  OTHER: 'Other audience',
  FACT_SHEET: 'Fact sheet',
  SALES_NOTES: 'Sales notes',
  CS_NOTES: 'Customer success notes',
  ANNOUNCEMENT: 'Announcement',
  FAQ: 'FAQ',
  SCREENSHOT: 'Screenshot',
  NEEDS_FACTS: 'Needs facts review',
  QUALIFIED: 'Qualified for preparation',
  NO_COMMUNICATION: 'No communication needed',
  DEFERRED: 'Deferred',
}
const blockerCopy: Record<string, string> = {
  OWNER_REQUIRED: 'Choose the person accountable for these facts.',
  REVIEWER_REQUIRED: 'Choose a fact reviewer.',
  SOURCE_REQUIRED: 'Choose provider evidence, or add a source link, file, or named human brief.',
  AUDIENCE_REQUIRED: 'Choose at least one audience.',
  MATERIAL_REQUIRED: 'Choose required materials for each audience.',
  ROLLOUT_UNKNOWN: 'Confirm the rollout state.',
  ROLLOUT_WITHDRAWN: 'A withdrawn release cannot be qualified.',
  AVAILABILITY_REQUIRED: 'Describe who can use the change.',
  EXCLUSIONS_REQUIRED: 'State exclusions, including when there are none.',
  ELIGIBILITY_REQUIRED: 'Describe eligibility for this limited rollout.',
  PLANNED_AVAILABILITY_REQUIRED: 'Explain when the planned release will become available.',
  READY_TIME_REQUIRED: 'Confirm when the release became available.',
}

function EvidenceFiles({
  ids,
  sources,
}: {
  ids: readonly string[]
  sources: QualificationRevision['sourceAssets']
}) {
  if (!ids.length) return null
  return (
    <ul className="grid gap-2">
      {ids.map((id) => (
        <li key={id} className="min-w-0">
          <a
            className="break-all text-sm underline"
            href={`/api/v1/assets/${encodeURIComponent(id)}/content`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {sources.find((source) => source.id === id)?.fileName ?? `Source file ${id}`} (opens in
            a new tab)
          </a>
        </li>
      ))}
    </ul>
  )
}

function SourceLinks({ urls }: { urls: readonly string[] }) {
  return (
    <ul className="grid gap-2">
      {urls.map((url) => (
        <li key={url}>
          <a
            className="break-all text-sm underline"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {url} (opens in a new tab)
          </a>
        </li>
      ))}
    </ul>
  )
}

function QualificationHistory({
  current,
  path,
  scope,
  members,
}: {
  current: QualificationRevision
  path: string
  scope: { userId: string; workspaceId: string }
  members: Member[]
}) {
  const [version, setVersion] = useState<QualificationRevision | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previous = (version ?? current).parentRevisionId
  const person = (id: string | null) =>
    id
      ? (members.find((member) => member.userId === id)?.name ??
        `Former or unavailable member (${id})`)
      : 'Not recorded'
  const load = async () => {
    if (!previous || busy) return
    setBusy(true)
    setError(null)
    try {
      setVersion(
        await settingsRequest(
          `${path}/revisions/${encodeURIComponent(previous)}`,
          qualificationRevisionSchema,
          { scope }
        )
      )
    } catch (failure) {
      setError(settingsErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  if (!current.parentRevisionId) return null
  return (
    <Disclosure className="rounded-md border p-3">
      <DisclosureTrigger>Previous facts and decisions</DisclosureTrigger>
      <DisclosureContent className="grid gap-3 pt-3">
        <p className="text-sm text-muted-foreground">
          Saved history does not change the current facts or their qualification.
        </p>
        {version ? (
          <article className="grid gap-3" aria-label={`Facts version ${version.version}`}>
            <h3 className="font-medium">Facts version {version.version}</h3>
            <p className="text-sm">
              Saved {new Date(version.createdAt).toLocaleString()} by{' '}
              {version.authorKind === 'api_key'
                ? `API key (${version.authorId})`
                : person(version.authorId)}
            </p>
            <dl className="grid gap-3">
              {[
                ['Accountable owner', person(version.facts.ownerUserId)],
                ['Fact reviewer', person(version.facts.factReviewerUserId)],
                ['Why this change matters', version.facts.rationale],
                ['Rollout state', labels[version.facts.rollout]],
                ['Availability', version.facts.availability],
                ['Exclusions and limitations', version.facts.exclusions],
                ['Limited rollout eligibility', version.facts.eligibility],
                ['Planned availability', version.facts.plannedAvailability],
                ['Actual ready time', version.facts.readyAt],
                ['Human brief', version.facts.humanBrief],
                ['Brief supplied by', person(version.facts.humanBriefAuthorUserId)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-sm font-medium">{label}</dt>
                  <dd className="whitespace-pre-wrap break-words">{value ?? 'Not recorded'}</dd>
                </div>
              ))}
            </dl>
            <SourceLinks urls={version.facts.sourceUrls} />
            <EvidenceFiles ids={version.facts.sourceAssetIds} sources={version.sourceAssets} />
            {version.sources.map((source) => (
              <article
                key={source.bindingId}
                aria-label="Reviewed provider evidence"
                className="rounded-md border p-3"
              >
                <ReleaseSourceSnapshot observation={source.observation} />
              </article>
            ))}
            <ul className="grid gap-2">
              {version.facts.requirements.map((audience) => (
                <li key={audience.id}>
                  <p className="font-medium">{audience.label ?? labels[audience.kind]}</p>
                  <p>
                    Required:{' '}
                    {audience.materials.map((material) => labels[material]).join(', ') ||
                      'None recorded'}
                  </p>
                  {audience.omissions.map((omission) => (
                    <p key={omission.material}>
                      Omitted {labels[omission.material]}: {omission.reason}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            {version.decision ? (
              <div className="rounded-md border p-3">
                <p className="font-medium">{labels[version.decision.decision]}</p>
                <p className="whitespace-pre-wrap break-words">{version.decision.reason}</p>
                <p className="text-sm">
                  {person(version.decision.humanUserId)} ·{' '}
                  {new Date(version.decision.createdAt).toLocaleString()}
                </p>
                {version.decision.revisitAt ? (
                  <p>Revisit: {new Date(version.decision.revisitAt).toLocaleString()}</p>
                ) : null}
              </div>
            ) : (
              <p>No decision was recorded for this version.</p>
            )}
          </article>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex flex-wrap gap-2">
          {previous ? (
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              {busy
                ? 'Loading version…'
                : error
                  ? 'Retry previous version'
                  : 'View previous version'}
            </Button>
          ) : (
            <p>First saved version.</p>
          )}
          {version ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setVersion(null)
                setError(null)
              }}
            >
              Start from latest version
            </Button>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  )
}

function draftFor(
  data: Qualification | null,
  userId: string,
  canDecide: boolean,
  sourceUrls: string[]
): ReleaseFacts {
  return (
    data?.current?.facts ?? {
      ownerUserId: userId,
      factReviewerUserId: canDecide ? userId : null,
      rationale: null,
      rollout: 'UNKNOWN',
      availability: null,
      exclusions: null,
      eligibility: null,
      plannedAvailability: null,
      readyAt: null,
      humanBrief: null,
      humanBriefAuthorUserId: null,
      sourceUrls: sourceUrls.slice(0, 200),
      sourceAssetIds: [],
      requirements: [],
    }
  )
}

/** Manual facts and a separate human decision; a save never approves a campaign. */
export function ReleaseQualification({
  initial,
  releaseId,
  workspaceId,
  userId,
  members,
  membersUnavailable,
  canEdit,
  canDecide,
  inactive,
  sourceUrls,
}: {
  initial: Qualification | null
  releaseId: string
  workspaceId: string
  userId: string
  members: Member[]
  membersUnavailable: boolean
  canEdit: boolean
  canDecide: boolean
  inactive: boolean
  sourceUrls: string[]
}) {
  const [data, setData] = useState(initial)
  const [saved, setSaved] = useState(() => draftFor(initial, userId, canDecide, sourceUrls))
  const [facts, setFacts] = useState(saved)
  const [links, setLinks] = useState(saved.sourceUrls.join('\n'))
  const [day, setDay] = useState(saved.readyAt?.slice(0, 10) ?? '')
  const [time, setTime] = useState(saved.readyAt?.slice(11, 16) ?? '')
  const [timeValid, setTimeValid] = useState(true)
  const [reason, setReason] = useState('')
  const [decision, setDecision] =
    useState<Exclude<DecideQualificationInput['decision'], 'REOPEN'>>('QUALIFIED')
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [sourceEditing, setSourceEditing] = useState(false)
  const [materialsEditing, setMaterialsEditing] = useState(false)
  const [kitEditing, setKitEditing] = useState(false)
  const [groupingEditing, setGroupingEditing] = useState(false)
  const [picker, setPicker] = useState(false)
  const [sources, setSources] = useState(initial?.current?.sourceAssets ?? [])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(
    initial ? null : 'Release facts could not load. Retry before editing.'
  )
  const path = `/api/v1/releases/${encodeURIComponent(releaseId)}/qualification`
  const scope = { userId, workspaceId }
  const dirty =
    JSON.stringify(facts) !== JSON.stringify(saved) ||
    links !== saved.sourceUrls.join('\n') ||
    day !== (saved.readyAt?.slice(0, 10) ?? '') ||
    time !== (saved.readyAt?.slice(11, 16) ?? '')
  useUnsavedSettings(dirty || pending !== null || reason.trim().length > 0)
  const editable =
    canEdit &&
    data?.enabled &&
    data.canonicalState === 'ACTIVE' &&
    !inactive &&
    !busy &&
    !sourceEditing &&
    !materialsEditing &&
    !kitEditing &&
    !groupingEditing &&
    !pending &&
    !stale &&
    !membersUnavailable &&
    data.state !== 'WITHDRAWN'
  const canReview =
    canDecide &&
    data?.current?.facts.factReviewerUserId === userId &&
    data.enabled &&
    data.canonicalState !== 'MERGED' &&
    !inactive &&
    !busy &&
    !sourceEditing &&
    !materialsEditing &&
    !kitEditing &&
    !groupingEditing &&
    !pending &&
    !stale &&
    !dirty
  const memberOptions = members.map((member) => ({
    value: member.userId,
    label: member.name,
    description: member.role.replaceAll('_', ' '),
  }))
  const reviewerOptions = memberOptions.filter((option) =>
    ['owner', 'admin', 'approver'].includes(
      members.find((member) => member.userId === option.value)?.role ?? ''
    )
  )
  const update = (change: Partial<ReleaseFacts>) => {
    setFacts((current) => ({ ...current, ...change }))
    setMessage(null)
  }
  const nullable = (value: string) => (value.trim() ? value : null)
  const replaceDraft = (next: Qualification) => {
    const nextFacts = draftFor(next, userId, canDecide, sourceUrls)
    setData(next)
    setFacts(nextFacts)
    setSaved(nextFacts)
    setSources(next.current?.sourceAssets ?? [])
    setLinks(nextFacts.sourceUrls.join('\n'))
    setDay(nextFacts.readyAt?.slice(0, 10) ?? '')
    setTime(nextFacts.readyAt?.slice(11, 16) ?? '')
    setReason('')
    setStale(false)
  }
  const reload = async () => {
    if (
      busy ||
      pending ||
      ((dirty || reason.trim()) &&
        !window.confirm('Discard your unsaved facts and load the latest saved version?'))
    )
      return
    setBusy(true)
    setError(null)
    try {
      replaceDraft(await settingsRequest(path, releaseQualificationSchema, { scope }))
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
    setMessage(null)
    let committed = false
    try {
      await settingsRequest(`${path}/${command.kind}`, qualificationResultSchema, {
        method: 'POST',
        scope,
        commandKey: command.key,
        body: command.body,
      })
      committed = true
      const latest = await settingsRequest(path, releaseQualificationSchema, { scope })
      replaceDraft(latest)
      setPending(null)
      setMessage(
        command.kind === 'revisions'
          ? latest.needsReview
            ? 'Facts saved. Review changed or unavailable source evidence before recording a decision.'
            : 'Facts saved. The assigned reviewer can now record a decision.'
          : command.body.decision === 'REOPEN'
            ? 'Release reopened for facts review. Confirm the rollout before qualifying it again.'
            : 'Decision recorded. Campaign approvals and publishing remain separate steps.'
      )
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
      }
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (!editable || !data) return
    if (!timeValid || Boolean(day) !== Boolean(time)) {
      setError('Choose both a date and a time, or clear both to keep the ready time unknown.')
      return
    }
    const ready = day && time ? new Date(`${day}T${time}:00Z`) : null
    if (ready && Number.isNaN(ready.getTime())) {
      setError('Choose a valid ready date and time.')
      return
    }
    const parsed = createQualificationSchema.safeParse({
      expectedRevision: data.revision,
      facts: {
        ...facts,
        sourceUrls: links
          .split('\n')
          .map((link) => link.trim())
          .filter(Boolean),
        readyAt: ready?.toISOString() ?? null,
      },
      reason: nullable(reason),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the release facts.')
      return
    }
    void send({ kind: 'revisions', key: crypto.randomUUID(), body: parsed.data })
  }
  const recordDecision = (action: DecideQualificationInput['decision'] = decision) => {
    if (!canReview || !data?.current) return
    const parsed = decideQualificationSchema.safeParse({
      expectedRevision: data.revision,
      qualificationRevisionId: data.current.id,
      decision: action,
      reason,
    })
    if (!parsed.success) {
      setError('Explain your decision before recording it.')
      return
    }
    void send({ kind: 'decisions', key: crypto.randomUUID(), body: parsed.data })
  }
  const textField = (
    field:
      | 'rationale'
      | 'availability'
      | 'exclusions'
      | 'eligibility'
      | 'plannedAvailability'
      | 'humanBrief',
    title: string,
    help?: string
  ) => (
    <div className="grid gap-2" key={field}>
      <Label htmlFor={`qualification-${field}`}>{title}</Label>
      {help ? (
        <p className="text-sm text-muted-foreground" id={`qualification-${field}-help`}>
          {help}
        </p>
      ) : null}
      <Textarea
        id={`qualification-${field}`}
        aria-describedby={help ? `qualification-${field}-help` : undefined}
        value={facts[field] ?? ''}
        maxLength={field === 'humanBrief' ? 10000 : 4000}
        disabled={!editable}
        onChange={(event) =>
          update(
            field === 'humanBrief' && !event.target.value.trim()
              ? { humanBrief: null, humanBriefAuthorUserId: null }
              : { [field]: nullable(event.target.value) }
          )
        }
      />
    </div>
  )
  return (
    <>
      {data ? (
        <ReleaseSourceSelection
          scope={scope}
          release={{ id: releaseId, revision: data.revision }}
          enabled={data.enabled && data.canonicalState === 'ACTIVE' && !inactive}
          canEdit={
            canEdit &&
            !dirty &&
            !pending &&
            !busy &&
            !stale &&
            !reason.trim() &&
            !groupingEditing &&
            !materialsEditing &&
            !kitEditing
          }
          onEditingChange={setSourceEditing}
          onSelected={async () =>
            replaceDraft(await settingsRequest(path, releaseQualificationSchema, { scope }))
          }
        />
      ) : null}
      {data ? (
        <ReleaseGrouping
          data={data}
          scope={scope}
          canEdit={
            canEdit &&
            !inactive &&
            !dirty &&
            !pending &&
            !busy &&
            !stale &&
            !reason.trim() &&
            !materialsEditing &&
            !kitEditing &&
            !sourceEditing
          }
          onEditingChange={setGroupingEditing}
          onGrouped={async () =>
            replaceDraft(await settingsRequest(path, releaseQualificationSchema, { scope }))
          }
        />
      ) : null}
      <Section
        title="Release facts and qualification"
        description="Confirm what changed, who it affects, and whether it needs communication. Qualification permits preparation; it does not approve content or publish it."
      >
        {data ? (
          <p role="status" className="font-medium">
            {labels[data.state]}
            {data.current ? ` · Facts version ${data.current.version}` : ''}
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="rounded-md border border-destructive p-3">
            <p>{error}</p>
            {pending ? (
              <>
                <p className="mt-2">
                  Keep this form open. Retry the same request to recover its saved result safely.
                </p>
                <Button disabled={busy} variant="outline" onClick={() => void send(pending)}>
                  Retry saved request
                </Button>
              </>
            ) : (
              <Button disabled={busy} variant="outline" onClick={() => void reload()}>
                {dirty ? 'Discard edits and load latest' : 'Load latest facts'}
              </Button>
            )}
          </div>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        {data && !data.enabled ? (
          <p>
            Manual qualification is disabled. An owner or admin can enable it in Workspace settings.
            Previous facts and decisions remain available.
          </p>
        ) : null}
        {membersUnavailable ? (
          <p role="alert">
            Workspace members could not load. Reload the page before changing assignments.
          </p>
        ) : null}
        {data?.needsReview ? (
          <p role="alert">
            Release context changed after these facts were saved. Review the source changes and save
            a new facts version before deciding.
          </p>
        ) : null}
        {data?.current?.sources.length ? (
          <Disclosure className="rounded-md border p-3">
            <DisclosureTrigger>Provider snapshots saved with these facts</DisclosureTrigger>
            <DisclosureContent className="grid gap-3 pt-3">
              {data.current.sources.map((source) => (
                <article
                  key={source.bindingId}
                  aria-label="Reviewed provider evidence"
                  className="rounded-md border p-3"
                >
                  <ReleaseSourceSnapshot observation={source.observation} />
                </article>
              ))}
            </DisclosureContent>
          </Disclosure>
        ) : null}
        {data?.missingFacts.length ? (
          <div className="rounded-md border p-3">
            <p className="font-medium">Before qualifying this release</p>
            <ul className="list-disc space-y-1 pl-5">
              {data.missingFacts.map((item, index) => (
                <li key={`${item.reason}-${item.objectId ?? index}`}>
                  {blockerCopy[item.reason] ?? 'Review the release facts.'}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data && (data.enabled || data.current) ? (
          <>
            <form
              className="grid min-w-0 gap-5"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="qualification-owner">Accountable owner</Label>
                  <Combobox
                    id="qualification-owner"
                    value={facts.ownerUserId}
                    valueLabel={
                      facts.ownerUserId &&
                      !memberOptions.some((option) => option.value === facts.ownerUserId)
                        ? `Unavailable member (${facts.ownerUserId})`
                        : undefined
                    }
                    options={memberOptions}
                    placeholder="Choose an owner"
                    disabled={!editable}
                    onValueChange={(ownerUserId) => update({ ownerUserId })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="qualification-reviewer">Fact reviewer</Label>
                  <Combobox
                    id="qualification-reviewer"
                    value={facts.factReviewerUserId}
                    valueLabel={
                      facts.factReviewerUserId &&
                      !reviewerOptions.some((option) => option.value === facts.factReviewerUserId)
                        ? `Unavailable reviewer (${facts.factReviewerUserId})`
                        : undefined
                    }
                    options={reviewerOptions}
                    placeholder="Choose a reviewer"
                    disabled={!editable}
                    onValueChange={(factReviewerUserId) => update({ factReviewerUserId })}
                  />
                </div>
              </div>
              {textField('rationale', 'Why this change matters')}
              <div className="grid gap-2">
                <Label htmlFor="qualification-rollout">Rollout state</Label>
                <Select
                  value={facts.rollout}
                  disabled={!editable}
                  onValueChange={(rollout) =>
                    update({ rollout: releaseRolloutSchema.parse(rollout) })
                  }
                >
                  <SelectTrigger id="qualification-rollout">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {releaseRolloutSchema.options.map((rollout) => (
                      <SelectItem value={rollout} key={rollout}>
                        {labels[rollout]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {textField(
                'availability',
                'Availability',
                'Who can use the change, and under what conditions?'
              )}
              {textField(
                'exclusions',
                'Exclusions and limitations',
                'State “No exclusions” if everyone in the named audience is eligible.'
              )}
              {facts.rollout === 'LIMITED'
                ? textField('eligibility', 'Limited rollout eligibility')
                : null}
              {facts.rollout === 'PLANNED'
                ? textField(
                    'plannedAvailability',
                    'Planned availability',
                    'Keep the actual ready time unknown until the release is available.'
                  )
                : null}
              <div className="grid gap-2">
                <Label htmlFor="qualification-ready-day">Owner-confirmed ready time (UTC)</Label>
                <div className="flex flex-wrap gap-2">
                  <DatePicker
                    id="qualification-ready-day"
                    value={day}
                    disabled={!editable}
                    onChange={setDay}
                  />
                  <TimePicker
                    aria-label="Ready time in UTC"
                    value={time}
                    disabled={!editable}
                    onChange={setTime}
                    onValidityChange={setTimeValid}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!editable}
                    onClick={() => {
                      setDay('')
                      setTime('')
                    }}
                  >
                    Keep time unknown
                  </Button>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="qualification-sources">Source links (one per line)</Label>
                <Textarea
                  id="qualification-sources"
                  value={links}
                  disabled={!editable}
                  onChange={(event) => setLinks(event.target.value)}
                />
                {data.current ? <SourceLinks urls={saved.sourceUrls} /> : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span>{facts.sourceAssetIds.length} source files attached</span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!editable}
                  onClick={() => setPicker(true)}
                >
                  Choose evidence from Library
                </Button>
              </div>
              <EvidenceFiles ids={facts.sourceAssetIds} sources={sources} />
              {textField(
                'humanBrief',
                'Human brief',
                'Use this when the facts come directly from a person. Name that person below.'
              )}
              {facts.humanBrief ? (
                <div className="grid gap-2">
                  <Label htmlFor="qualification-brief-author">Brief supplied by</Label>
                  <Combobox
                    id="qualification-brief-author"
                    value={facts.humanBriefAuthorUserId}
                    valueLabel={
                      facts.humanBriefAuthorUserId &&
                      !memberOptions.some((option) => option.value === facts.humanBriefAuthorUserId)
                        ? `Unavailable member (${facts.humanBriefAuthorUserId})`
                        : undefined
                    }
                    options={memberOptions}
                    disabled={!editable}
                    onValueChange={(humanBriefAuthorUserId) => update({ humanBriefAuthorUserId })}
                  />
                </div>
              ) : null}
              <fieldset className="grid gap-3">
                <legend className="mb-3 font-medium">Audiences and required materials</legend>
                {facts.requirements.map((audience, index) => {
                  const changeAudience = (change: Partial<typeof audience>) =>
                    update({
                      requirements: facts.requirements.map((item) =>
                        item.id === audience.id ? { ...item, ...change } : item
                      ),
                    })
                  return (
                    <fieldset
                      key={audience.id}
                      className="grid min-w-0 gap-3 rounded-md border p-3"
                    >
                      <legend className="px-1">Audience {index + 1}</legend>
                      <Select
                        value={audience.kind}
                        disabled={!editable}
                        onValueChange={(kind) =>
                          changeAudience({ kind: releaseAudienceSchema.shape.kind.parse(kind) })
                        }
                      >
                        <SelectTrigger aria-label={`Audience ${index + 1} type`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {releaseAudienceSchema.shape.kind.options.map((kind) => (
                            <SelectItem value={kind} key={kind}>
                              {labels[kind]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Label htmlFor={`qualification-audience-${audience.id}`}>
                        Audience name{audience.kind === 'OTHER' ? ' (required)' : ' (optional)'}
                      </Label>
                      <Input
                        id={`qualification-audience-${audience.id}`}
                        value={audience.label ?? ''}
                        maxLength={160}
                        disabled={!editable}
                        onChange={(event) =>
                          changeAudience({ label: nullable(event.target.value) })
                        }
                      />
                      {releaseMaterialSchema.options.map((material) => {
                        const omission = audience.omissions.find(
                          (item) => item.material === material
                        )
                        return (
                          <div className="grid gap-2" key={material}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <Label htmlFor={`${audience.id}-${material}`}>
                                {labels[material]}
                              </Label>
                              <Select
                                value={
                                  audience.materials.includes(material)
                                    ? 'required'
                                    : omission
                                      ? 'omit'
                                      : 'unused'
                                }
                                disabled={!editable}
                                onValueChange={(mode) =>
                                  changeAudience({
                                    materials: [
                                      ...audience.materials.filter((item) => item !== material),
                                      ...(mode === 'required' ? [material] : []),
                                    ],
                                    omissions: [
                                      ...audience.omissions.filter(
                                        (item) => item.material !== material
                                      ),
                                      ...(mode === 'omit' ? [{ material, reason: '' }] : []),
                                    ],
                                  })
                                }
                              >
                                <SelectTrigger id={`${audience.id}-${material}`} className="w-44">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="unused">Not selected</SelectItem>
                                  <SelectItem value="required">Required</SelectItem>
                                  <SelectItem value="omit">Omit with reason</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            {omission ? (
                              <Textarea
                                aria-label={`Reason for omitting ${labels[material]} for audience ${index + 1}`}
                                value={omission.reason}
                                maxLength={4000}
                                disabled={!editable}
                                onChange={(event) =>
                                  changeAudience({
                                    omissions: audience.omissions.map((item) =>
                                      item.material === material
                                        ? { ...item, reason: event.target.value }
                                        : item
                                    ),
                                  })
                                }
                              />
                            ) : null}
                          </div>
                        )
                      })}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!editable}
                        onClick={() =>
                          update({
                            requirements: facts.requirements.filter(
                              (item) => item.id !== audience.id
                            ),
                          })
                        }
                      >
                        Remove audience {index + 1}
                      </Button>
                    </fieldset>
                  )
                })}
                <Button
                  type="button"
                  variant="outline"
                  disabled={!editable || facts.requirements.length >= 20}
                  onClick={() =>
                    update({
                      requirements: [
                        ...facts.requirements,
                        {
                          id: crypto.randomUUID(),
                          kind: 'SALES',
                          label: null,
                          materials: [],
                          omissions: [],
                        },
                      ],
                    })
                  }
                >
                  Add audience
                </Button>
              </fieldset>
              <div className="flex flex-wrap items-center gap-3">
                {data.state !== 'WITHDRAWN' ? (
                  <Button
                    type="submit"
                    disabled={
                      !editable ||
                      (!dirty &&
                        data.current !== null &&
                        !data.current.decision &&
                        !data.needsReview) ||
                      !timeValid
                    }
                  >
                    {busy ? 'Saving…' : 'Save facts for review'}
                  </Button>
                ) : null}
                {dirty ? (
                  <span role="status">Unsaved facts</span>
                ) : data.current ? (
                  <span>Facts saved</span>
                ) : null}
              </div>
            </form>
            {data.current?.decision ? (
              <div className="rounded-md border p-3">
                <p className="font-medium">
                  Saved decision: {labels[data.current.decision.decision]}
                </p>
                <p>{data.current.decision.reason}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(data.current.decision.createdAt).toLocaleString()}
                </p>
              </div>
            ) : null}
            {data.current ? (
              <QualificationHistory
                key={data.current.id}
                current={data.current}
                path={path}
                scope={scope}
                members={members}
              />
            ) : null}
            {data.current ? (
              <form
                className="grid gap-3 border-t pt-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  recordDecision(data.state === 'WITHDRAWN' ? 'REOPEN' : decision)
                }}
              >
                <p className="font-medium">
                  {data.state === 'WITHDRAWN' ? 'Reopen release' : 'Reviewer decision'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {data.state === 'WITHDRAWN'
                    ? 'Only the assigned reviewer can reopen this release. Saved facts are retained, and rollout must be confirmed again.'
                    : 'Only the assigned reviewer can record this decision. Save any edited facts first.'}
                </p>
                {data.state !== 'WITHDRAWN' ? (
                  <Select
                    value={decision}
                    disabled={!canReview}
                    onValueChange={(value) => setDecision(qualificationDecisionSchema.parse(value))}
                  >
                    <SelectTrigger aria-label="Qualification decision">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {qualificationDecisionSchema.options.map((value) => (
                        <SelectItem
                          key={value}
                          value={value}
                          disabled={Boolean(data.current?.decision) && value !== 'WITHDRAWN'}
                        >
                          {labels[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <Label htmlFor="qualification-decision-reason">
                  {data.state === 'WITHDRAWN'
                    ? 'Why are you reopening this release?'
                    : 'Reason for the decision'}
                </Label>
                <Textarea
                  id="qualification-decision-reason"
                  value={reason}
                  maxLength={4000}
                  disabled={!canReview}
                  onChange={(event) => setReason(event.target.value)}
                  required
                />
                <Button
                  type="submit"
                  disabled={
                    !canReview ||
                    !reason.trim() ||
                    (data.state !== 'WITHDRAWN' &&
                      ((Boolean(data.current.decision) && decision !== 'WITHDRAWN') ||
                        (data.needsReview && decision !== 'WITHDRAWN') ||
                        (decision === 'QUALIFIED' && data.missingFacts.length > 0)))
                  }
                >
                  {data.state === 'WITHDRAWN' ? 'Reopen for facts review' : 'Record decision'}
                </Button>
              </form>
            ) : null}
          </>
        ) : null}
        {picker ? (
          <ReleaseEvidencePicker
            selected={facts.sourceAssetIds}
            onClose={() => setPicker(false)}
            onSelect={(sourceAssetIds, pickedSources) => {
              update({ sourceAssetIds })
              setSources((current) => [
                ...current.filter(
                  (source) =>
                    sourceAssetIds.includes(source.id) &&
                    !pickedSources.some((picked) => picked.id === source.id)
                ),
                ...pickedSources,
              ])
            }}
          />
        ) : null}
      </Section>
      {data ? (
        <ReleaseClaimReview
          releaseId={releaseId}
          workspaceId={workspaceId}
          userId={userId}
          qualification={data}
          canEdit={canEdit}
          canDecide={canDecide}
          disabled={
            inactive ||
            busy ||
            pending !== null ||
            stale ||
            dirty ||
            reason.trim().length > 0 ||
            sourceEditing ||
            kitEditing ||
            groupingEditing
          }
          onRevision={(revision) =>
            setData((current) => (current ? { ...current, revision } : current))
          }
          onReload={replaceDraft}
          onEditing={setMaterialsEditing}
        />
      ) : null}
      {data ? (
        <ReleaseKitReview
          releaseId={releaseId}
          workspaceId={workspaceId}
          userId={userId}
          qualification={data}
          members={members}
          canEdit={canEdit}
          canDecide={canDecide}
          disabled={
            inactive ||
            busy ||
            pending !== null ||
            stale ||
            dirty ||
            reason.trim().length > 0 ||
            sourceEditing ||
            groupingEditing ||
            materialsEditing ||
            membersUnavailable
          }
          onRevision={(revision) =>
            setData((current) => (current ? { ...current, revision } : current))
          }
          onReload={replaceDraft}
          onEditing={setKitEditing}
        />
      ) : null}
    </>
  )
}

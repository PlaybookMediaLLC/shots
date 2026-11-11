'use client'

import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { PencilIcon as Pencil } from '@phosphor-icons/react/dist/ssr/Pencil'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { StoredIdealCustomerProfile } from '@/lib/tenant/ideal-customer-profile'
import {
  type IdealCustomerProfileFieldName,
  idealCustomerProfileUpsertSchema,
} from '@/lib/tenant/ideal-customer-profile-schema'
import type { StoredEnrichment, StoredOnboardingRun } from '@/lib/tenant/onboarding-runs'
import type { StoredProductProfile } from '@/lib/tenant/product-profile'
import {
  type ProductProfileFieldName,
  productProfileUpsertSchema,
} from '@/lib/tenant/product-profile-schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { isTerminal, ONBOARDING_STAGES, stagePercent, useOnboardingRun } from './run-progress'
import { Label } from '@/components/ui/label'

type Provenance = StoredProductProfile['provenance'][ProductProfileFieldName]

const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

/** Where a value came from and how sure its source was. */
export function SourceBadge({ entry }: { entry: Provenance | undefined }) {
  if (!entry) return <span className="text-xs text-muted-foreground">Not filled in</span>
  const sure = entry.confidence ? ` · ${Math.round(entry.confidence * 100)}% sure` : ''
  const label =
    entry.editedByUser && entry.source === 'manual'
      ? 'Written by you'
      : entry.editedByUser
        ? 'Accepted by you'
        : entry.source === 'enrichment'
          ? `Found elsewhere${sure}`
          : `From your site${sure}`
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs',
        entry.editedByUser
          ? 'border-emerald-400/30 text-emerald-700 dark:text-emerald-300'
          : entry.source === 'enrichment'
            ? 'border-amber-400/30 text-amber-700 dark:text-amber-200'
            : 'border-foreground/[0.12] text-foreground/80'
      )}
      data-source={entry.source}
      title={entry.url}
    >
      {label}
    </span>
  )
}

/** The run's progress: one bar overall and one per stage, polled until it ends. */
function RunProgress({
  onCancel,
  onRerun,
  run,
}: {
  onCancel: () => void
  onRerun: () => void
  run: StoredOnboardingRun
}) {
  const running = !isTerminal(run.status)
  const summary = {
    cancelled: 'Stopped. Everything read so far is kept.',
    completed: 'Done. Your profile is as complete as your site allows.',
    failed: run.errorMessage ?? 'The background read failed. Your draft is saved.',
    partial: run.errorMessage ?? 'Stopped early. What it read is kept.',
    queued: 'Starting…',
    running: `Still reading: ${run.pagesProcessed} of ${run.pagesDiscovered} pages so far.`,
  }[run.status]
  return (
    <section
      aria-label="Background read"
      className="flex flex-col gap-3 rounded-xl border border-foreground/[0.08] p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <p aria-live="polite" className="text-sm text-foreground/80" role="status">
          {summary}
        </p>
        {running ? (
          <Button className="rounded-lg" onClick={onCancel} size="sm" variant="outline">
            Stop
          </Button>
        ) : (
          <Button className="rounded-lg" onClick={onRerun} size="sm" variant="outline">
            Read again
          </Button>
        )}
      </div>
      <div
        aria-label="Overall progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={run.progress}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
        role="progressbar"
      >
        <div
          className="h-full bg-foreground transition-all"
          style={{ width: `${run.progress}%` }}
        />
      </div>
      <ol className="grid gap-2 sm:grid-cols-2">
        {ONBOARDING_STAGES.map((stage) => {
          const value = stagePercent(run, stage)
          return (
            <li className="flex flex-col gap-1" key={stage.key}>
              <span className="flex items-center gap-1.5 text-xs text-foreground/65">
                {value === 100 ? (
                  <Check aria-hidden className="size-3" />
                ) : running && value > 0 ? (
                  <Loader2 aria-hidden className="size-3 animate-spin" />
                ) : null}
                {stage.label}
              </span>
              <div
                aria-label={stage.label}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={value}
                className="h-1 overflow-hidden rounded-full bg-foreground/[0.06]"
                role="progressbar"
              >
                <div className="h-full bg-neutral-300" style={{ width: `${value}%` }} />
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

type FieldSpec = { field: string; label: string; list?: boolean }

const PRODUCT_FIELDS: FieldSpec[] = [
  { field: 'name', label: 'Product name' },
  { field: 'summary', label: 'What it is' },
  { field: 'problem', label: 'The problem it solves' },
  { field: 'audience', label: 'Who it is for' },
  { field: 'capabilities', label: 'Capabilities', list: true },
  { field: 'proofPoints', label: 'Proof points', list: true },
  { field: 'pricingNote', label: 'Pricing' },
  { field: 'competitors', label: 'Alternatives', list: true },
]

const ICP_FIELDS: FieldSpec[] = [
  { field: 'personas', label: 'Who buys it', list: true },
  { field: 'pains', label: 'Pains', list: true },
  { field: 'jobs', label: 'Jobs they hire it for', list: true },
  { field: 'buyingTriggers', label: 'What makes them look', list: true },
  { field: 'objections', label: 'Why they hesitate', list: true },
  { field: 'channels', label: 'Channels', list: true },
]

/** A field's value as the review screen shows and edits it, one item per line. */
type ListItem = string | { claim: string } | { role: string; seniority?: string; teamSize?: string }

function displayValue(source: object | null, field: string): string {
  const value = (source as Record<string, unknown> | null)?.[field]
  if (Array.isArray(value)) {
    return (value as ListItem[])
      .map((item) =>
        typeof item === 'string'
          ? item
          : 'claim' in item
            ? item.claim
            : [item.role, item.seniority, item.teamSize].filter(Boolean).join(', ')
      )
      .join('\n')
  }
  return typeof value === 'string' ? value : ''
}

/** One reviewed field: its value, where it came from, and accept or edit. */
export function ReviewField({
  entry,
  label,
  list,
  onAccept,
  onSave,
  value,
}: {
  entry: Provenance | undefined
  label: string
  list?: boolean
  onAccept: () => Promise<void>
  onSave: (text: string) => Promise<void>
  value: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [editBase, setEditBase] = useState(value)
  const [busy, setBusy] = useState(false)
  const id = `review-${label.toLowerCase().replace(/\W+/g, '-')}`
  const labelId = `${id}-label`
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
      setEditing(false)
    } catch {
      // The owner displays the save error; retain the draft for retry.
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex flex-col gap-2 border-b border-foreground/[0.06] py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label
          className="text-ui-lg font-medium text-foreground"
          htmlFor={editing ? id : undefined}
          id={labelId}
        >
          {label}
        </Label>
        <SourceBadge entry={entry} />
      </div>
      {editing ? (
        <Textarea
          className="min-h-20 rounded-lg"
          disabled={busy}
          id={id}
          onChange={(event) => setDraft(event.target.value)}
          value={draft}
        />
      ) : (
        <p aria-labelledby={labelId} className="text-sm whitespace-pre-line text-foreground/65">
          {value || 'Nothing yet.'}
        </p>
      )}
      {editing && value !== editBase ? (
        <p className="text-xs text-muted-foreground" role="status">
          This field was updated in the background. Save to keep your edit, or cancel to use the
          latest value.
        </p>
      ) : null}
      <div className="flex gap-2">
        {editing ? (
          <>
            <Button
              className="rounded-lg"
              disabled={busy}
              onClick={() => void run(() => onSave(list ? lines(draft).join('\n') : draft.trim()))}
              size="sm"
            >
              Save {label.toLowerCase()}
            </Button>
            <Button
              className="rounded-lg"
              disabled={busy}
              onClick={() => setEditing(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              aria-label={`Accept ${label.toLowerCase()}`}
              className="rounded-lg"
              disabled={busy || !value || entry?.editedByUser}
              onClick={() => void run(onAccept)}
              size="sm"
              variant="outline"
            >
              <Check aria-hidden className="size-3.5" />
              {entry?.editedByUser ? 'Kept' : 'Accept'}
            </Button>
            <Button
              aria-label={`Edit ${label.toLowerCase()}`}
              className="rounded-lg"
              disabled={busy}
              onClick={() => {
                setDraft(value)
                setEditBase(value)
                setEditing(true)
              }}
              size="sm"
              variant="ghost"
            >
              <Pencil aria-hidden className="size-3.5" />
              Edit
            </Button>
          </>
        )}
      </div>
    </li>
  )
}

/** Enrichment findings that have no profile field: firmographics, reach, apps. */
function EnrichmentFacts({ findings }: { findings: StoredEnrichment[] }) {
  const facts = findings.flatMap((finding) => {
    const value = finding.value as Record<string, unknown> | Array<Record<string, unknown>>
    if (finding.field === 'firmographics' && value && !Array.isArray(value)) {
      return Object.entries(value).map(([key, item]) => ({
        finding,
        label: key,
        text: String(item),
      }))
    }
    if (finding.field === 'apps' && Array.isArray(value)) {
      return value.map((app) => ({
        finding,
        label: String(app.name),
        text: `${app.rating}★ from ${app.ratingCount} ratings`,
      }))
    }
    if (finding.field === 'reach' && value && !Array.isArray(value)) {
      return Object.entries(value).map(([key, item]) => ({
        finding,
        label: key,
        text: Object.entries(item as Record<string, unknown>)
          .filter(([name]) => name !== 'url')
          .map(([name, count]) => `${count} ${name}`)
          .join(', '),
      }))
    }
    return []
  })
  if (facts.length === 0) return null
  return (
    <section aria-label="Found elsewhere" className="flex flex-col gap-2">
      <h2 className="text-base font-medium text-foreground">Found elsewhere</h2>
      <ul className="flex flex-col gap-1 text-sm text-foreground/65">
        {facts.map((fact) => (
          <li key={`${fact.finding.id}-${fact.label}`}>
            <span className="text-foreground">{fact.label}</span>: {fact.text}{' '}
            <span className="text-xs text-muted-foreground">
              ({fact.finding.provider}, {Math.round(fact.finding.confidence * 100)}% sure)
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The onboarding review screen (docs/rfcs/032): the fast path's drafts at
 * once, a live progress bar for each stage of the background read, a
 * source and confidence badge on every field, and accept or edit per field.
 * Accepting or editing locks a field, so the background read never changes it.
 */
export function OnboardingReview({
  icp: initialIcp,
  onManual,
  onConfirm,
  profile: initialProfile,
  run: initialRun,
}: {
  icp: StoredIdealCustomerProfile | null
  onManual: () => void
  onConfirm: (profile: StoredProductProfile) => void
  profile: StoredProductProfile
  run: StoredOnboardingRun
}) {
  const trpcClient = useTRPCClient()
  const [profile, setProfile] = useState(initialProfile)
  const [icp, setIcp] = useState(initialIcp)
  const [findings, setFindings] = useState<{ runId: string; data: StoredEnrichment[] } | null>(null)
  const [findingsError, setFindingsError] = useState<string | null>(null)
  const [findingsAttempt, setFindingsAttempt] = useState(0)
  const [findingsLoading, setFindingsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A stage finished: the drafts may have changed underneath.
  const { lost, run, setRun, retry } = useOnboardingRun(initialRun, async (_run, signal) => {
    const [productResult, icpResult] = await Promise.all([
      trpcClient.productProfile.get.query(undefined, { signal }),
      trpcClient.idealCustomerProfile.get.query(undefined, { signal }),
    ])
    if (signal.aborted) return
    if (productResult.productProfile) setProfile(productResult.productProfile)
    setIcp(icpResult.idealCustomerProfile)
  })

  useEffect(() => {
    setFindingsLoading(false)
    setFindingsError(null)
    if (!isTerminal(run.status)) return
    const abort = new AbortController()
    setFindingsLoading(true)
    setFindingsError(null)
    trpcClient.onboarding.enrichment
      .query({ runId: run.id }, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) setFindings({ runId: run.id, data: result.enrichment })
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setFindingsError(
            'Findings could not be refreshed. Previously loaded evidence is still shown.'
          )
      })
      .finally(() => {
        if (!abort.signal.aborted) setFindingsLoading(false)
      })
    return () => abort.abort()
  }, [findingsAttempt, run.id, run.status, trpcClient])

  const attempt = async (work: () => Promise<void>) => {
    setError(null)
    try {
      await work()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'That did not save.')
      throw requestError
    }
  }
  const saveProduct = (input: Record<string, unknown>) =>
    attempt(async () => {
      const parsed = productProfileUpsertSchema.parse(input)
      setProfile((await trpcClient.productProfile.upsert.mutate(parsed)).productProfile)
    })
  const saveIcp = (input: Record<string, unknown>) =>
    attempt(async () => {
      const parsed = idealCustomerProfileUpsertSchema.parse(input)
      setIcp((await trpcClient.idealCustomerProfile.upsert.mutate(parsed)).idealCustomerProfile)
    })
  const productValue = (field: string, text: string) => {
    if (field === 'proofPoints') {
      return lines(text).map((claim) => ({
        claim,
        sourceUrl: profile.proofPoints.find((point) => point.claim === claim)?.sourceUrl,
      }))
    }
    return ['capabilities', 'competitors'].includes(field) ? lines(text) : text
  }
  const icpValue = (field: string, text: string) =>
    field === 'personas'
      ? lines(text).map((line) => {
          const [role = '', seniority, teamSize] = line.split(',').map((part) => part.trim())
          return { role, seniority: seniority || undefined, teamSize: teamSize || undefined }
        })
      : lines(text)

  return (
    <div className="flex flex-col gap-8">
      <RunProgress
        onCancel={() =>
          void trpcClient.onboarding.cancel
            .mutate({ runId: run.id })
            .then((result) => setRun(result.run))
            .catch(() => setError('The run could not be stopped. Try again.'))
        }
        onRerun={() =>
          void trpcClient.onboarding.rerun
            .mutate({ runId: run.id })
            .then((result) => setRun(result.run))
            .catch((requestError: unknown) =>
              setError(requestError instanceof Error ? requestError.message : 'Try again later.')
            )
        }
        run={run}
      />
      {error || lost ? (
        <Alert variant="destructive">
          <AlertDescription>
            {error ?? 'Lost track of the background read. Retry to see where it got to.'}
            {lost ? (
              <Button onClick={retry} size="sm" variant="outline">
                Retry connection
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <section aria-label="Your product" className="flex flex-col">
        <h2 className="text-base font-medium text-foreground">Your product</h2>
        <ul>
          {PRODUCT_FIELDS.map((spec) => (
            <ReviewField
              entry={profile.provenance[spec.field as ProductProfileFieldName]}
              key={spec.field}
              label={spec.label}
              list={spec.list}
              onAccept={() => saveProduct({ acceptFields: [spec.field] })}
              onSave={(text) => saveProduct({ [spec.field]: productValue(spec.field, text) })}
              value={displayValue(profile, spec.field)}
            />
          ))}
        </ul>
      </section>
      <section aria-label="Your ideal customer" className="flex flex-col">
        <h2 className="text-base font-medium text-foreground">Your ideal customer</h2>
        <ul>
          {ICP_FIELDS.map((spec) => (
            <ReviewField
              entry={icp?.provenance[spec.field as IdealCustomerProfileFieldName]}
              key={spec.field}
              label={spec.label}
              list={spec.list}
              onAccept={() => saveIcp({ acceptFields: [spec.field] })}
              onSave={(text) => saveIcp({ [spec.field]: icpValue(spec.field, text) })}
              value={displayValue(icp, spec.field)}
            />
          ))}
        </ul>
      </section>
      {findingsError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {findingsError}{' '}
            <Button
              disabled={findingsLoading}
              onClick={() => setFindingsAttempt((value) => value + 1)}
              size="sm"
              variant="outline"
            >
              Retry findings
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {findingsLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading findings…
        </p>
      ) : null}
      {findings?.runId === run.id ? <EnrichmentFacts findings={findings.data} /> : null}
      {!findingsLoading &&
      !findingsError &&
      findings?.runId === run.id &&
      findings.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No additional findings were found.</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="custom"
          size={null}
          className="text-sm text-foreground/65 underline underline-offset-4 hover:text-foreground"
          onClick={onManual}
          type="button"
        >
          Edit everything in a form instead
        </Button>
        <Button className="rounded-lg" onClick={() => onConfirm(profile)}>
          Looks right
        </Button>
      </div>
    </div>
  )
}

'use client'

import { WarningIcon as Alert02Icon } from '@phosphor-icons/react/dist/ssr/Warning'
import { SealCheckIcon as DocumentValidationIcon } from '@phosphor-icons/react/dist/ssr/SealCheck'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { useUnsavedCampaignChanges } from '@/components/campaigns/useUnsavedCampaignChanges'
import { RunButton } from '@/components/launch/RunButton'
import { EmptyState } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { citedSourceIds } from '@/lib/launch/citations'
import {
  type ReleaseSpecContent,
  SPEC_SECTION_LABELS,
  SPEC_SECTIONS,
  type SpecSource,
} from '@/lib/launch/spec-schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { SourceList } from './citations'
import { OpenQuestions } from './OpenQuestions'
import { type EditableSection, SpecSection } from './SpecSection'
import { type VersionOption, VersionSelect, VersionStatus } from './VersionSelect'

export type SpecView = VersionOption & { content: ReleaseSpecContent; sources: SpecSource[] }

const EDITABLE = SPEC_SECTIONS.filter(
  (section): section is EditableSection => section !== 'openQuestions'
)

/**
 * The release spec: version history, AI drafting and approval, cited
 * sections with plain-text editing, sources with injection flags, and open
 * questions whose answers feed the next draft.
 */
export function SpecEditor({
  activeRunId,
  aiConfigured,
  brief,
  campaignId,
  canApprove,
  canEdit,
  lastRunError,
  latestId,
  spec,
  versions,
}: {
  activeRunId: string | null
  aiConfigured: boolean
  /** What the team entered, shown when a reviewer opens a [brief] citation. */
  brief: string
  campaignId: string
  canApprove: boolean
  canEdit: boolean
  lastRunError: string | null
  latestId: string | null
  /** The version on screen: the latest unless an earlier one was picked. */
  spec: SpecView | null
  versions: VersionOption[]
}) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const pathname = usePathname()
  const [editing, setEditing] = useState<EditableSection | null>(null)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, startRefresh] = useTransition()
  const [answersDirty, setAnswersDirty] = useState(false)
  const [sectionDirty, setSectionDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const blocked = answersDirty || sectionDirty || saving || refreshing
  useUnsavedCampaignChanges(blocked)

  const draft = canEdit ? (
    <RunButton
      activeRunId={activeRunId}
      className={spec ? 'md:items-end' : 'items-center'}
      disabled={!aiConfigured || blocked || editing !== null || approving}
      doneMessage="Spec drafted"
      hint="Reads the brief and sources; about a minute"
      initialError={lastRunError}
      label={spec ? 'Redraft spec' : 'Draft spec'}
      onStart={() => trpcClient.launch.spec.generate.mutate({ campaignId })}
      runningLabel="Drafting spec…"
      variant={spec ? 'outline' : 'default'}
    />
  ) : null
  const aiNote =
    canEdit && !aiConfigured ? (
      <p className="text-xs text-muted-foreground">AI is not configured.</p>
    ) : null

  if (!spec) {
    return (
      <EmptyState
        action={
          draft ? (
            <div className="flex flex-col items-center gap-2">
              {draft}
              {aiNote}
            </div>
          ) : undefined
        }
        description="Draft a product spec from the release brief and its sources. Every claim cites where it came from, and gaps become open questions for you to answer."
        icon={DocumentValidationIcon}
        title="No spec yet"
      />
    )
  }

  const current = spec
  const isLatest = current.id === latestId
  const editable = canEdit && isLatest
  const flagged = current.sources.filter((source) => source.flagged)
  const index = { brief, byId: new Map(current.sources.map((source) => [source.id, source])) }

  async function save(content: ReleaseSpecContent, summary: string) {
    if (saving || refreshing || approving) throw new Error('Wait for the current change to finish.')
    setSaving(true)
    try {
      const { spec: saved } = await trpcClient.launch.spec.update.mutate({
        baseSpecId: current.id,
        campaignId,
        content,
        summary,
      })
      toast.success(`Saved as v${saved.version}`)
      // Close the editor together with the refreshed content, not before it.
      startRefresh(() => {
        setEditing(null)
        setSectionDirty(false)
        setAnswersDirty(false)
        router.refresh()
      })
    } finally {
      setSaving(false)
    }
  }

  async function approve() {
    if (blocked || editing !== null || approving) return
    const unanswered = current.content.openQuestions.filter(
      (question) => !question.answer.trim()
    ).length
    if (
      unanswered &&
      !window.confirm(
        `${unanswered} questions are unanswered. Review these gaps before approving. Approve anyway?`
      )
    )
      return
    setApproving(true)
    setError(null)
    try {
      await trpcClient.launch.spec.approve.mutate({ specId: current.id })
      toast.success(`Spec v${current.version} approved`)
      startRefresh(() => router.refresh())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The spec could not be approved.')
    } finally {
      setApproving(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <VersionSelect current={current.id} versions={versions} />
            <VersionStatus status={current.status} />
          </div>
          {current.changeSummary ? (
            <p className="text-sm text-muted-foreground">{current.changeSummary}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div className="flex flex-wrap items-start gap-2 md:justify-end">
            {draft}
            {isLatest && canApprove && current.status !== 'APPROVED' ? (
              <Button
                className="rounded-lg"
                disabled={approving || blocked || editing !== null}
                onClick={() => void approve()}
                size="sm"
                type="button"
              >
                {approving ? 'Approving…' : 'Approve spec'}
              </Button>
            ) : null}
          </div>
          {aiNote}
        </div>
      </div>

      {answersDirty || editing !== null ? (
        <p className="text-sm text-muted-foreground">
          Save or discard the open edits before approving or editing another section.
        </p>
      ) : null}

      {error ? (
        <p
          className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {editable && current.status === 'APPROVED' ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Editing this approved spec creates a new draft version that needs approval again.
        </p>
      ) : null}
      {!isLatest ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-4 py-3 text-sm text-foreground/80 ring-1 ring-foreground/[0.08]">
          <span>You are viewing v{current.version}, an earlier version. It is read-only.</span>
          <Link className="font-medium text-foreground hover:underline" href={pathname}>
            View the latest
          </Link>
        </div>
      ) : null}

      {flagged.length > 0 ? (
        <div className="flex gap-3 rounded-xl bg-red-500/[0.06] px-4 py-3 ring-1 ring-red-500/25">
          <Alert02Icon
            aria-hidden
            className="mt-0.5 shrink-0 text-red-700 dark:text-red-300"
            size={16}
          />
          <div className="text-sm">
            <p className="font-medium text-red-700 dark:text-red-200">
              {flagged.length === 1 ? '1 source reads' : `${flagged.length} sources read`} like
              instructions to an AI: {flagged.map((source) => source.id).join(', ')}
            </p>
            <p className="mt-0.5 text-red-700/70 dark:text-red-200/70">
              {flagged.length === 1
                ? 'The draft treated it as evidence only. Check the claims that cite it before you approve.'
                : 'The draft treated them as evidence only. Check the claims that cite them before you approve.'}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-8">
          {EDITABLE.map((section) => (
            <SpecSection
              aiConfigured={aiConfigured}
              campaignId={campaignId}
              content={current.content}
              editable={editable && !approving && !saving && !refreshing}
              editing={editing === section}
              index={index}
              key={section}
              locked={answersDirty || (editing !== null && editing !== section)}
              onCancel={() => {
                setEditing(null)
                setSectionDirty(false)
              }}
              onDirtyChange={setSectionDirty}
              onEdit={() => setEditing(section)}
              onSave={(value) => {
                if (answersDirty)
                  return Promise.reject(new Error('Save or discard your answers first.'))
                return save(
                  { ...current.content, [section]: value } as ReleaseSpecContent,
                  `Edited ${SPEC_SECTION_LABELS[section]}`
                )
              }}
              section={section}
              specId={current.id}
            />
          ))}
          <OpenQuestions
            editable={editable}
            key={current.id}
            disabled={editing !== null || saving || refreshing || approving}
            onDirtyChange={setAnswersDirty}
            onSave={(openQuestions) =>
              save({ ...current.content, openQuestions }, 'Answered open questions')
            }
            questions={current.content.openQuestions}
          />
        </div>
        <div className="lg:sticky lg:top-6 lg:-m-px lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:p-px">
          <SourceList cited={citedSourceIds(current.content)} sources={current.sources} />
        </div>
      </div>
    </>
  )
}

'use client'

import { ChecklistIcon as CheckListIcon } from '@/components/platform-shell/icons'
import { LaptopIcon as LaptopIcon } from '@/components/platform-shell/icons'
import { StoreIcon as SmartPhone01Icon } from '@/components/platform-shell/icons'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { type ReactNode, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { ProduceControl } from '@/components/launch/assets/ProduceControl'
import { RevisePanel } from '@/components/launch/RevisePanel'
import { RunButton } from '@/components/launch/RunButton'
import { EmptyState, Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  type CampaignPlanContent,
  LAUNCH_CHANNEL_LABELS,
  PLAN_PHASE_LABELS,
  PLAN_PHASES,
  type ReleaseSpecContent,
  resolveClaimRef,
  SPEC_SECTION_LABELS,
} from '@/lib/launch/spec-schema'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { ChipPopover } from '../spec/citations'
import { type VersionOption, VersionSelect, VersionStatus } from '../spec/VersionSelect'
import { PlanJsonEditor } from './PlanJsonEditor'

export type PlanView = VersionOption & { content: CampaignPlanContent; specId: string | null }
type SpecRef = { content: ReleaseSpecContent; id: string; version: number }

const ASSET_KIND: Record<CampaignPlanContent['assets'][number]['kind'], string> = {
  feature_shot: 'Feature shot',
  hero: 'Hero',
  social_card: 'Social card',
  story: 'Story',
}

const REF_LABEL: Record<string, string> = {
  audience: 'Audience',
  beforeAfter: 'Before/after',
  capabilities: 'Capability',
  faqs: 'FAQ',
  limitations: 'Limitation',
  'messaging.pillars': 'Pillar',
  problem: 'Problem',
  proofPoints: 'Proof point',
  whatChanged: 'Change',
}

/** capabilities.0 → "Capability 1". */
function refLabel(ref: string): string {
  if (ref === 'summary') return 'Summary'
  if (ref === 'messaging.positioning') return 'Positioning'
  const dot = ref.lastIndexOf('.')
  const head = ref.slice(0, dot)
  return `${REF_LABEL[head] ?? head} ${Number(ref.slice(dot + 1)) + 1}`
}

function KeyChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 items-center rounded-md bg-foreground/[0.04] px-1.5 font-mono text-[11px] font-medium text-foreground/80 ring-1 ring-foreground/[0.1] ring-inset">
      {children}
    </span>
  )
}

function ClaimChip({ claimRef, spec }: { claimRef: string; spec: SpecRef | null }) {
  const claim = spec ? resolveClaimRef(spec.content, claimRef) : null
  const label = refLabel(claimRef)
  return (
    <ChipPopover
      className="font-sans text-xs"
      label={label}
      name={`Spec claim: ${label}`}
      tone={claim ? 'gray' : 'red'}
    >
      {claim ? (
        <>
          <p className="text-xs text-muted-foreground">
            {SPEC_SECTION_LABELS[claim.section]} · spec v{spec?.version}
          </p>
          <p className="leading-6 text-foreground">{claim.text}</p>
        </>
      ) : (
        <p>{claimRef} is not in the spec this plan was built from.</p>
      )}
    </ChipPopover>
  )
}

/** The asset's aspect ratio as a small frame. */
function FormatBox({ format }: { format: string }) {
  const [width = 1, height = 1] = format.split(':').map(Number)
  return (
    <div
      aria-hidden
      className="grid size-14 shrink-0 place-items-center rounded-lg bg-black/25 ring-1 ring-foreground/[0.06]"
    >
      <div
        className={cn(
          'rounded-[3px] bg-foreground/[0.07] ring-1 ring-foreground/20',
          width >= height ? 'w-10' : 'h-10'
        )}
        style={{ aspectRatio: `${width} / ${height}` }}
      />
    </div>
  )
}

/** "nextjs.org/blog/next-15", plus the section when the URL targets one (#id). */
function captureTarget(url: string): { page: string; section: string | null } {
  if (!url) return { page: 'Main product URL', section: null }
  const hash = url.indexOf('#')
  return {
    page: (hash === -1 ? url : url.slice(0, hash)).replace(/^https?:\/\//, ''),
    section: hash === -1 ? null : url.slice(hash + 1),
  }
}

function Detail({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground/80">{children}</dd>
    </div>
  )
}

/**
 * The campaign plan: version history, AI planning and approval, channels,
 * angles with the spec claims behind them, assets with capture hints, and
 * the launch timeline.
 */
export function PlanView({
  activeRunId,
  aiConfigured,
  campaignId,
  canApprove,
  canEdit,
  hasApproved,
  productionRun,
  lastRunError,
  latestId,
  plan,
  spec,
  versions,
  workingSpec,
}: {
  activeRunId: string | null
  aiConfigured: boolean
  campaignId: string
  canApprove: boolean
  canEdit: boolean
  /** Some version is approved, so production can start. */
  hasApproved: boolean
  productionRun?: { id: string; startedAt: string } | null
  lastRunError: string | null
  latestId: string | null
  /** The version on screen: the latest unless an earlier one was picked. */
  plan: PlanView | null
  /** The spec version the plan was built from, to resolve its claim references. */
  spec: SpecRef | null
  versions: VersionOption[]
  /** The spec a new plan would be built from. */
  workingSpec: { id: string; version: number }
}) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const pathname = usePathname()
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, startRefresh] = useTransition()

  const runButton = canEdit ? (
    <RunButton
      activeRunId={activeRunId}
      className={plan ? 'md:items-end' : 'items-center'}
      disabled={!aiConfigured}
      doneMessage="Plan ready"
      hint="About a minute"
      initialError={lastRunError}
      label={plan ? 'Replan' : 'Plan campaign'}
      onStart={() => trpcClient.launch.plan.generate.mutate({ campaignId })}
      runningLabel="Planning…"
      variant={plan ? 'outline' : 'default'}
    />
  ) : null
  const aiNote =
    canEdit && !aiConfigured ? (
      <p className="text-xs text-muted-foreground">AI is not configured.</p>
    ) : null

  if (!plan) {
    return (
      <EmptyState
        action={
          runButton ? (
            <div className="flex flex-col items-center gap-2">
              {runButton}
              {aiNote}
            </div>
          ) : undefined
        }
        description={`Plan the launch from spec v${workingSpec.version}: channels and their roles, angles tied to the messaging, the assets to produce, and a day-by-day timeline.`}
        icon={CheckListIcon}
        title="No plan yet"
      />
    )
  }

  const current = plan
  const { content } = current
  const isLatest = current.id === latestId
  const editable = canEdit && isLatest
  const angles = new Map(content.angles.map((angle) => [angle.key, angle]))
  const timeline = [...content.timeline].sort((a, b) => a.day - b.day)

  async function approve() {
    setApproving(true)
    setError(null)
    try {
      await trpcClient.launch.plan.approve.mutate({ planId: current.id })
      toast.success(`Plan v${current.version} approved`)
      startRefresh(() => router.refresh())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The plan could not be approved.')
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
            {runButton}
            {isLatest && canApprove && current.status !== 'APPROVED' ? (
              <Button
                className="rounded-lg"
                disabled={approving}
                onClick={() => void approve()}
                size="sm"
                type="button"
              >
                {approving ? 'Approving…' : 'Approve plan'}
              </Button>
            ) : null}
          </div>
          {aiNote}
        </div>
      </div>

      {error ? (
        <p
          className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {error}
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

      {canEdit && hasApproved ? (
        <ProduceControl
          activeRun={productionRun ?? null}
          blocker={!aiConfigured ? 'ai' : null}
          campaignId={campaignId}
          lastError={null}
        />
      ) : null}

      <Section title="Summary">
        <Group>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-sm leading-6 text-foreground">{content.summary}</p>
            <p className="text-xs text-muted-foreground">
              {spec ? (
                <>
                  Built from{' '}
                  <Link
                    className="text-foreground/80 hover:text-foreground hover:underline"
                    href={`/campaigns/${campaignId}/spec${spec.id === workingSpec.id ? '' : `?version=${spec.id}`}`}
                  >
                    spec v{spec.version}
                  </Link>
                  {spec.id === workingSpec.id
                    ? '.'
                    : `. The spec is now at v${workingSpec.version}; replan to use it.`}
                </>
              ) : (
                'The spec version this plan was built from no longer exists.'
              )}
            </p>
          </div>
        </Group>
        {editable ? (
          <div className="-mt-1">
            <RevisePanel
              campaignId={campaignId}
              disabled={!aiConfigured}
              placeholder="For example: add a teaser on LinkedIn and drop the story asset"
              target={{ planId: current.id, type: 'plan' }}
              triggerLabel="Revise plan with AI"
            />
          </div>
        ) : null}
      </Section>

      <Section description="Where the launch goes and what each channel is for." title="Channels">
        <Group>
          {content.channels.map((channel) => (
            <Row
              description={channel.role}
              key={channel.channel}
              label={LAUNCH_CHANNEL_LABELS[channel.channel]}
            >
              <p className="text-xs leading-5 text-foreground/65 md:text-right">
                {channel.cadence}
              </p>
            </Row>
          ))}
        </Group>
      </Section>

      <Section
        description="The stories the campaign tells, each backed by spec claims."
        title="Angles"
      >
        <ul className="grid gap-4 md:grid-cols-2">
          {content.angles.map((angle) => (
            <li
              className="flex flex-col gap-3 rounded-2xl bg-foreground/[0.015] p-5 ring-1 ring-foreground/[0.08]"
              id={`plan-${angle.key}`}
              key={angle.key}
            >
              <div className="flex items-center gap-2">
                <KeyChip>{angle.key}</KeyChip>
                <h3 className="text-ui-lg font-medium text-foreground">{angle.title}</h3>
              </div>
              <p className="text-xs text-muted-foreground">Pillar · {angle.pillar}</p>
              <p className="text-sm leading-6 text-foreground/80">{angle.hook}</p>
              <div className="mt-auto flex flex-wrap gap-1 pt-1">
                {angle.specRefs.map((ref) => (
                  <ClaimChip claimRef={ref} key={ref} spec={spec} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        description="Visuals to produce: what each shows, its format, and what to capture."
        title="Assets"
      >
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {content.assets.map((asset) => {
            const target = captureTarget(asset.captureHint.url)
            const DeviceIcon = asset.captureHint.device === 'mobile' ? SmartPhone01Icon : LaptopIcon
            return (
              <li
                className="flex flex-col gap-4 rounded-2xl bg-foreground/[0.015] p-5 ring-1 ring-foreground/[0.08]"
                key={asset.key}
              >
                <div className="flex items-start gap-4">
                  <FormatBox format={asset.format} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <KeyChip>{asset.key}</KeyChip>
                      <h3 className="text-ui-lg font-medium text-foreground">
                        {ASSET_KIND[asset.kind]}
                      </h3>
                      <span className="text-xs text-muted-foreground">{asset.format}</span>
                      {asset.variants === 2 ? <Pill tone="purple">A/B pair</Pill> : null}
                    </div>
                    <p className="mt-2 text-sm leading-6 text-foreground">“{asset.headline}”</p>
                  </div>
                </div>
                <dl className="mt-auto grid gap-2 text-xs leading-5">
                  <Detail label="Shows">{asset.capability}</Detail>
                  <Detail label="Angle">
                    {asset.angleKey}
                    {angles.get(asset.angleKey) ? ` · ${angles.get(asset.angleKey)?.title}` : ''}
                  </Detail>
                  <Detail label="Capture">
                    <span className="inline-flex items-center gap-1">
                      <DeviceIcon aria-hidden size={13} />
                      {asset.captureHint.device === 'mobile' ? 'Mobile' : 'Desktop'}
                    </span>{' '}
                    · <span className="break-all">{target.page}</span>
                    {target.section ? ` · section #${target.section}` : ''}
                    <span className="mt-1 block text-foreground/65">{asset.captureHint.focus}</span>
                  </Detail>
                </dl>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section description="Days are relative to launch day." title="Timeline">
        {PLAN_PHASES.map((phase) => {
          const items = timeline.filter((item) => item.phase === phase)
          if (items.length === 0) return null
          return (
            <div className="flex flex-col gap-2" key={phase}>
              <h3 className="text-ui-lg font-medium text-foreground/80">{PLAN_PHASE_LABELS[phase]}</h3>
              <Group>
                <ol className="divide-y divide-foreground/[0.07]">
                  {items.map((item, position) => (
                    <li
                      className="flex flex-col gap-1 px-5 py-3.5 md:flex-row md:gap-6"
                      key={position}
                    >
                      <p className="shrink-0 text-sm md:w-64">
                        <span className="font-medium text-foreground tabular-nums">
                          {item.day < 0 ? `Day −${-item.day}` : `Day ${item.day}`}
                        </span>
                        <span className="text-muted-foreground"> · </span>
                        <span className="text-foreground">
                          {LAUNCH_CHANNEL_LABELS[item.channel]}
                        </span>
                        <span className="text-muted-foreground">
                          {' · '}
                          {[item.angleKey, ...item.assetKeys].join(' · ')}
                        </span>
                      </p>
                      {item.note ? (
                        <p className="text-sm leading-6 text-foreground/65">{item.note}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Group>
            </div>
          )
        })}
      </Section>

      {editable ? (
        <PlanJsonEditor
          campaignId={campaignId}
          content={content}
          key={current.id}
          planId={current.id}
        />
      ) : null}
    </>
  )
}

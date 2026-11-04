import { PlanCampaignAction } from '@/components/launch/PlanCampaignAction'
import { CheckIcon as Tick02Icon } from '@phosphor-icons/react/dist/ssr/Check'
import Link from 'next/link'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Pill, type PillTone } from '@/components/platform-ui'
import type { LaunchRunKind, LaunchRunView } from '@/lib/launch/runs'
import { cn } from '@/lib/utils'

type Version = { createdAt: Date; version: number }
type Versions = { approved: Version | null; latest: Version | null } | null

type Step = {
  action: { href: string; label: string }
  description: string
  done: boolean
  /** A failure or a pending decision, shown under the description. */
  note?: { text: string; tone: 'red' | 'yellow' }
  status: { label: string; tone: PillTone }
  title: string
}

/** A failed run, unless a newer version has been saved since. */
function failure(run: LaunchRunView | undefined, latest: Version | null): string | null {
  if (run?.status !== 'FAILED') return null
  if (latest && latest.createdAt > run.startedAt) return null
  return run.error ?? 'The last run failed.'
}

function versionStep(versions: Versions, run: LaunchRunView | undefined, runningLabel: string) {
  const approved = versions?.approved ?? null
  const latest = versions?.latest ?? null
  const error = failure(run, latest)
  const status: Step['status'] =
    run?.status === 'RUNNING'
      ? { label: runningLabel, tone: 'blue' }
      : approved
        ? { label: `v${approved.version} approved`, tone: 'green' }
        : latest
          ? { label: `v${latest.version} draft`, tone: 'gray' }
          : error
            ? { label: 'Failed', tone: 'red' }
            : { label: 'Not started', tone: 'gray' }
  const note: Step['note'] = error
    ? { text: `Failed: ${error}`, tone: 'red' }
    : approved && latest && latest.version > approved.version
      ? { text: `v${latest.version} is a newer draft.`, tone: 'yellow' }
      : undefined
  return { approved, latest, note, status }
}

/**
 * Where the launch pipeline stands, stage by stage: spec, plan, produce,
 * review. Each stage links to its page; the next one to do is highlighted.
 */
export function PipelineSteps({
  campaignId,
  canEdit = false,
  hasRelease,
  plan,
  produced,
  review,
  runs,
  spec,
}: {
  campaignId: string
  canEdit?: boolean
  hasRelease: boolean
  plan: Versions
  produced: { designs: number; posts: number }
  review: { approved: number; proposals: number; total: number }
  runs: Partial<Record<LaunchRunKind, LaunchRunView>>
  spec: Versions
}) {
  const base = `/campaigns/${campaignId}`
  const specStep = versionStep(spec, runs.spec, 'Drafting…')
  const planStep = versionStep(plan, runs.plan, 'Planning…')
  const producing = runs.produce?.status === 'RUNNING'
  const produceError =
    runs.produce?.status === 'FAILED' ? (runs.produce.error ?? 'The last run failed.') : null
  const madeSomething = produced.designs + produced.posts > 0
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

  const steps: Step[] = [
    {
      action: {
        href: `${base}/spec`,
        label: specStep.latest
          ? specStep.approved
            ? 'View spec'
            : 'Review spec'
          : hasRelease
            ? 'Draft spec'
            : 'Open spec',
      },
      description: hasRelease
        ? 'A cited product spec from the brief and its sources.'
        : 'Link a release brief to draft a spec.',
      done: Boolean(specStep.approved),
      note: specStep.note,
      status: hasRelease ? specStep.status : { label: 'Needs a release', tone: 'gray' },
      title: 'Spec',
    },
    {
      action: {
        href: `${base}/${specStep.latest ? 'plan' : 'spec'}`,
        label: !specStep.latest
          ? 'Draft the spec first'
          : planStep.latest
            ? planStep.approved
              ? 'View plan'
              : 'Review plan'
            : 'Plan campaign',
      },
      description: 'Channels, angles, assets, and a launch timeline.',
      done: Boolean(planStep.approved),
      note: planStep.note,
      status: planStep.status,
      title: 'Plan',
    },
    {
      action: {
        href: `${base}/${!specStep.latest ? 'spec' : !planStep.latest ? 'plan' : 'assets'}`,
        label: madeSomething
          ? 'Open assets'
          : !specStep.latest
            ? 'Draft the spec first'
            : !planStep.latest
              ? 'Plan campaign'
              : 'Produce',
      },
      description: 'On-brand visuals and channel copy from the plan.',
      done: madeSomething,
      note: produceError ? { text: `Failed: ${produceError}`, tone: 'red' } : undefined,
      status: producing
        ? { label: 'Producing…', tone: 'blue' }
        : madeSomething
          ? {
              label: `${plural(produced.designs, 'visual')} · ${plural(produced.posts, 'post')}`,
              tone: 'green',
            }
          : { label: 'Not started', tone: 'gray' },
      title: 'Produce',
    },
    {
      action: { href: `${base}/copy`, label: 'Review copy' },
      description: 'Approve, reject, or revise posts before they go out.',
      done: review.total > 0 && review.approved === review.total,
      note:
        review.proposals > 0
          ? {
              text: `${plural(review.proposals, 'AI proposal')} waiting for a decision.`,
              tone: 'yellow',
            }
          : undefined,
      status:
        review.total === 0
          ? { label: 'Not started', tone: 'gray' }
          : review.approved === review.total
            ? { label: 'All approved', tone: 'green' }
            : { label: `${review.approved} of ${review.total} approved`, tone: 'yellow' },
      title: 'Review',
    },
  ]
  const next = steps.findIndex((step) => !step.done)

  return (
    <section aria-labelledby="launch-pipeline">
      <h2 className="sr-only" id="launch-pipeline">
        Launch pipeline
      </h2>
      {/* The 1px gap over a hairline background draws the dividers at any column count. */}
      <ol className="grid gap-px overflow-hidden rounded-2xl bg-foreground/[0.07] ring-1 ring-foreground/[0.08] md:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <li
            className={cn(
              'flex flex-col gap-3 p-5',
              index === next ? 'bg-secondary' : 'bg-secondary'
            )}
            key={step.title}
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium ring-1 ring-inset',
                  step.done
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25'
                    : index === next
                      ? 'bg-foreground text-background ring-white'
                      : 'text-muted-foreground ring-foreground/[0.12]'
                )}
              >
                {step.done ? <Tick02Icon size={14} /> : index + 1}
              </span>
              <h3 className="text-ui-lg font-medium text-foreground">{step.title}</h3>
              <span className="ml-auto">
                <Pill tone={step.status.tone}>{step.status.label}</Pill>
              </span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{step.description}</p>
            {step.note ? (
              <p
                className={cn(
                  'text-xs leading-5',
                  step.note.tone === 'red'
                    ? 'text-red-700 dark:text-red-300'
                    : 'text-amber-700 dark:text-amber-300'
                )}
              >
                {step.note.text}
              </p>
            ) : null}
            <div className="mt-auto pt-1">
              {step.title === 'Plan' && canEdit && specStep.latest && !planStep.latest ? (
                <PlanCampaignAction
                  campaignId={campaignId}
                  activeRunId={runs.plan?.status === 'RUNNING' ? runs.plan.id : null}
                />
              ) : index === next ? (
                <ButtonLink className="rounded-lg" href={step.action.href} size="sm">
                  {step.action.label}
                </ButtonLink>
              ) : (
                <Link
                  className="text-xs font-medium text-foreground/65 transition-colors hover:text-foreground"
                  href={step.action.href}
                >
                  {step.action.label} <span aria-hidden>→</span>
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

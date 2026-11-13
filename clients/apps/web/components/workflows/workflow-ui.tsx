'use client'

import Link from 'next/link'
import { Pill, type PillTone } from '@/components/platform-ui'
import { type AutomationRunSummary } from '@/lib/api/contracts/workflow-runs'
import {
  automationRunStatusSchema,
  type AutomationRunStatus,
} from '@/lib/api/contracts/workflow-runs'

const STATUS: Record<AutomationRunStatus, { label: string; tone: PillTone }> = {
  queued: { label: 'Queued', tone: 'gray' },
  running: { label: 'Running', tone: 'blue' },
  succeeded: { label: 'Succeeded', tone: 'green' },
  skipped: { label: 'Skipped', tone: 'gray' },
  failed: { label: 'Failed', tone: 'red' },
  needs_attention: { label: 'Needs attention', tone: 'yellow' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
}

/** A run state as a pill; unknown states render verbatim rather than guessed. */
export function RunStatusPill({ status }: { status: string }) {
  const known = automationRunStatusSchema.safeParse(status)
  if (!known.success) return <Pill>{status}</Pill>
  return <Pill tone={STATUS[known.data].tone}>{STATUS[known.data].label}</Pill>
}

/** Human label for a run state. */
export function runStatusLabel(status: AutomationRunStatus) {
  return STATUS[status].label
}

/** Runs that are still executing and worth polling. */
export function runActive(status: string) {
  return status === 'queued' || status === 'running'
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** “3 minutes ago”, or a date when older than a week. */
export function relativeTime(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  const abs = Math.abs(seconds)
  if (abs < 60) return RELATIVE.format(Math.round(seconds), 'second')
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), 'hour')
  if (abs < 604_800) return RELATIVE.format(Math.round(seconds / 86_400), 'day')
  return new Date(iso).toLocaleDateString()
}

/** Elapsed time between two instants, or until now for an open run. */
export function duration(start: string, end: string | null) {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`
}

/** The object that triggered a run: a release tag, PR number, or deployment. */
export function triggeringObject(item: AutomationRunSummary) {
  const { snapshot } = item.event
  const tag = snapshot.fields['release.tag']?.values?.[0]
  if (snapshot.family === 'pull_request.merged' && snapshot.number) return `PR #${snapshot.number}`
  if (snapshot.family === 'release.published' && tag) return tag
  if (snapshot.family === 'tag.pushed') return snapshot.fields['tag.name']?.values?.[0] ?? 'tag'
  if (snapshot.family === 'milestone.closed') return `Milestone ${snapshot.title}`
  if (snapshot.family === 'deployment.succeeded')
    return snapshot.fields['deployment.environment']?.values?.[0] ?? 'deployment'
  return snapshot.objectId
}

/** Failure and attention codes as sentences a customer can act on. */
export const FAILURE_CODES: Record<string, string> = {
  activity_failed: 'An activity exhausted its retries. Eligible for retry.',
  access_revoked: 'Automation was disabled or GitHub access was revoked.',
  cancelled: 'Cancelled by an administrator or a configuration change.',
  configuration_invalid: 'Required configuration or evidence was unavailable.',
  insufficient_credits: 'Not enough AI credits for the generation budget.',
  not_entitled: 'The workspace plan does not include this action.',
  prohibited_terms: 'Copy used a term the brand prohibits.',
  model_unavailable: 'No worker had an AI model configured.',
  model_output_invalid: 'The model returned incomplete or invalid content. Retry this step.',
  renderer_unavailable: 'No worker could reach the design renderer.',
  capture_missing: 'No product page has a current capture to put in the creatives.',
  capture_unavailable: 'No worker could capture and store product pages.',
  waiting_for_deployment: 'The app kept reporting another commit, so nothing was captured.',
  deployment_unverified: 'The app did not report its deployed commit, so nothing was captured.',
  capture_refused:
    'The page asks visitors to sign in, or is not public, so it cannot show this deployment.',
  needs_auth: 'The signed-in session ended. Reconnect it in Signed-in capture to continue.',
  capture_pending: 'The signed-in capture had not finished when this step stopped waiting.',
  action_failed: 'The action failed; see the node for details.',
  missing: 'Event evidence was missing, so no branch was chosen.',
  pending: 'Event enrichment was still pending, so no branch was chosen.',
  unavailable: 'Event evidence was unavailable, so no branch was chosen.',
  invalid: 'A condition was invalid for the recorded evidence.',
  no_match: 'No active workflow matched this event.',
}

/** Where a page sits in Automate; the last item is this page. */
export function AutomateBreadcrumb({
  current,
  trail,
}: {
  current: string
  trail: { href: string; label: string }[]
}) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <li>Automate</li>
        {trail.map((item) => (
          <li className="flex items-center gap-1.5" key={item.href}>
            <span aria-hidden="true">/</span>
            {/* inline-flex centers the text in the 44px touch target phones give links. */}
            <Link
              className="inline-flex items-center hover:text-foreground hover:underline"
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
        <li aria-current="page" className="flex items-center gap-1.5 text-foreground">
          <span aria-hidden="true">/</span>
          {current}
        </li>
      </ol>
    </nav>
  )
}

/** Where a deployment workflow gets its trigger, which its own settings cannot show. */
export function DeploymentHint() {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      A deployment starts this workflow only after you activate it and select it in{' '}
      <Link className="underline" href="/workflows/deployments">
        Deployments
      </Link>
      .
    </p>
  )
}

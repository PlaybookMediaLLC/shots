'use client'

import { useQuery } from '@tanstack/react-query'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { useTRPC } from '@/lib/trpc/react'
import { connectedSources } from '@/lib/workflows/actions'
import { FAMILY_NAMES } from './workflow-canvas'
import { RunStatusPill, relativeTime, triggeringObject } from './workflow-ui'
import { WorkflowRunLink } from './WorkflowRunLink'
import { WorkflowSetup } from './WorkflowSetup'

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Where Automate stands: what still needs setting up, each page's state, and the latest runs. */
export function AutomateOverview({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const overview = useQuery(
    trpc.releaseAutomation.overview.queryOptions(undefined, { staleTime: 60_000 })
  )
  const runs = useQuery(
    trpc.releaseAutomation.recentRuns.queryOptions(undefined, { staleTime: 10_000 })
  )
  const hosts = useQuery(trpc.frontendDeployments.sources.queryOptions())
  const capture = useQuery(trpc.capture.overview.queryOptions(undefined, { enabled: canManage }))
  const failure = overview.error ?? runs.error ?? hosts.error
  if (!overview.data) {
    return failure ? (
      <Alert variant="destructive">
        <AlertDescription>{getErrorMessage(failure)}</AlertDescription>
      </Alert>
    ) : (
      <div aria-label="Loading Automate" className="grid gap-3" role="status">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    )
  }

  const workflows = overview.data.definitions.filter((definition) => !definition.archived)
  const active = workflows.filter((definition) => definition.enabled).length
  const watched = connectedSources(overview.data).length
  const counts = overview.data.runCounts ?? {}
  const totalRuns = Object.values(counts).reduce((total, count) => total + count, 0)
  const attention = counts.needs_attention ?? 0
  const pages = [
    {
      href: '/workflows',
      label: 'Workflows',
      status: workflows.length
        ? `${active} active, ${workflows.length - active} not active`
        : 'None yet',
    },
    {
      href: '/workflows/sources',
      label: 'Repositories',
      status: watched ? `${plural(watched, 'repository', 'repositories')} watched` : 'None watched',
    },
    {
      href: attention ? '/workflows/runs?status=needs_attention' : '/workflows/runs',
      label: 'Runs',
      status: totalRuns
        ? `${plural(totalRuns, 'run')}${attention ? `, ${attention} needing attention` : ''}`
        : 'None yet',
    },
    {
      href: '/workflows/deployments',
      label: 'Deployments',
      status: hosts.data?.sources.length
        ? `${plural(hosts.data.sources.length, 'host')} connected`
        : 'No hosts connected',
    },
    ...(canManage
      ? [
          {
            href: '/workflows/connections',
            label: 'Signed-in capture',
            status: !capture.data?.available
              ? 'Not set up'
              : `${plural(capture.data.connections.length, 'sign-in')} connected`,
          },
        ]
      : []),
  ]
  const recent = runs.data?.items ?? []
  return (
    <div className="flex flex-col gap-8">
      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{getErrorMessage(failure)}</AlertDescription>
        </Alert>
      ) : null}
      {canManage ? <WorkflowSetup overview={overview.data} /> : null}
      <Section title="At a glance">
        <Group>
          {pages.map((page) => (
            <Row description={page.status} key={page.label} label={page.label} layout="inline">
              <ButtonLink href={page.href} size="sm" variant="outline">
                Open<span className="sr-only"> {page.label}</span>
              </ButtonLink>
            </Row>
          ))}
        </Group>
      </Section>
      {recent.length ? (
        <Section
          actions={
            <ButtonLink href="/workflows/runs" size="sm" variant="outline">
              All runs
            </ButtonLink>
          }
          title="Latest runs"
        >
          <Group>
            {recent.map((item) => (
              <Row
                description={`${FAMILY_NAMES[item.event.snapshot.family]} · ${triggeringObject(item)} · ${relativeTime(item.run.createdAt)}`}
                key={item.run.id}
                label={
                  <WorkflowRunLink
                    className="hover:underline"
                    href={`/workflows/runs/${item.run.id}`}
                  >
                    {item.event.snapshot.title}
                  </WorkflowRunLink>
                }
                layout="inline"
              >
                <RunStatusPill status={item.run.status} />
              </Row>
            ))}
          </Group>
        </Section>
      ) : null}
    </div>
  )
}

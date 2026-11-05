'use client'

import { useQuery } from '@tanstack/react-query'
import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr/CheckCircle'
import { CircleIcon } from '@phosphor-icons/react/dist/ssr/Circle'
import Link from 'next/link'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Row, Section } from '@/components/platform-ui'
import { useGitHubConnections } from '@/components/workspace/GitHubConnections'
import type { AutomationOverview } from '@/lib/api/contracts/release-automation'
import { useTRPC } from '@/lib/trpc/react'
import { connectedSources } from '@/lib/workflows/actions'

/** The next thing an owner or admin needs to do, from what the workspace actually has. */
export function WorkflowSetup({ overview }: { overview: AutomationOverview }) {
  const github = useGitHubConnections()
  const watched = connectedSources(overview).length > 0
  const workflows = overview.definitions.filter((definition) => !definition.archived)
  if (github.isPending || workflows.some((definition) => definition.enabled)) return null
  const connected = watched || github.data?.connections.some(({ status }) => status === 'ACTIVE')
  const steps = [
    { done: connected, href: '/workflows/sources', label: 'Connect GitHub' },
    { done: watched, href: '/workflows/sources', label: 'Watch a repository' },
    { done: workflows.length > 0, href: '/workflows/new', label: 'Pick a template' },
    {
      action: 'Open your workflow',
      done: false,
      href: workflows[0] ? `/workflows/${workflows[0].id}` : '/workflows/new',
      label: 'Activate it',
    },
  ]
  const next = steps.findIndex((step) => !step.done)
  return (
    <Section
      description={
        <>
          Turn a published release, a merged pull request, or a production deployment into campaign
          drafts for review.{' '}
          <Link className="underline" href="/docs/automate" rel="noopener" target="_blank">
            Read the guide
          </Link>
        </>
      }
      title={workflows.length ? 'Finish setting up' : 'Set up your first workflow'}
    >
      <Group>
        {steps.map((step, index) => (
          <Row key={step.label}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span
                className={
                  index === next
                    ? 'flex items-center gap-2 text-ui-lg font-medium text-foreground'
                    : 'flex items-center gap-2 text-ui-lg text-muted-foreground'
                }
              >
                {step.done ? (
                  <CheckCircleIcon
                    aria-label="Done"
                    className="shrink-0 text-emerald-600 dark:text-emerald-400"
                    size={18}
                    weight="fill"
                  />
                ) : (
                  <CircleIcon aria-label="To do" className="shrink-0" size={18} />
                )}
                {step.label}
              </span>
              {index === next ? (
                <ButtonLink href={step.href} size="sm">
                  {step.action ?? step.label}
                </ButtonLink>
              ) : null}
            </div>
          </Row>
        ))}
      </Group>
    </Section>
  )
}

/** Until a repository is watched, the setup list's next step is the main action, not this. */
export function WorkflowsPageAction() {
  const trpc = useTRPC()
  const overview = useQuery(
    trpc.releaseAutomation.overview.queryOptions(undefined, { staleTime: 60_000 })
  )
  const needsRepository = overview.data && connectedSources(overview.data).length === 0
  return (
    <ButtonLink href="/workflows/new" variant={needsRepository ? 'outline' : 'default'}>
      New workflow
    </ButtonLink>
  )
}

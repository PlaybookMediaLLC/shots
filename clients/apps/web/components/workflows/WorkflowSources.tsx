'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { GitHubConnections, useGitHubConnections } from '@/components/workspace/GitHubConnections'
import { getErrorMessage } from '@/components/workspace/settings-client'
import type { AutomationOverview } from '@/lib/api/contracts/release-automation'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

type Source = AutomationOverview['sources'][number]

const CONNECTION_LABELS: Record<string, string> = {
  connected: 'Connected',
  disconnected: 'GitHub account disconnected from this workspace',
  deleted: 'GitHub App uninstalled',
  suspended: 'GitHub App suspended in GitHub',
  repository_access_removed: 'Repository access removed or no longer watched',
}

/**
 * The repositories workflows run for: the GitHub connection, what is watched,
 * its branch and who handles its changes. Every change is an owner/admin
 * session action.
 */
export function WorkflowSources({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const overview = useQuery(
    trpc.releaseAutomation.overview.queryOptions(undefined, { staleTime: 60_000 })
  )
  const github = useGitHubConnections(canManage)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const failure = actionError ?? (overview.error ? getErrorMessage(overview.error) : null)
  const perform = (action: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    void action()
      .then(() => overview.refetch())
      .catch((error) => setActionError(getErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  const hasConnection = github.data?.connections.some(({ status }) => status === 'ACTIVE')
  return (
    <div className="flex flex-col gap-8">
      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      <div data-tour-id="automate-repositories">
        {canManage ? (
          <GitHubConnections />
        ) : (
          <p className="text-sm text-muted-foreground">
            An owner or administrator connects GitHub and chooses repositories.
          </p>
        )}
      </div>
      <Section
        description="Shots listens to these repositories. Nothing runs until you activate a workflow."
        title="Watched repositories"
      >
        <Group>
          {!overview.data ? (
            <Row>
              <p className="text-sm text-muted-foreground" role="status">
                Loading repositories…
              </p>
            </Row>
          ) : overview.data.sources.length === 0 ? (
            <Row>
              <p className="text-sm text-muted-foreground">
                {!canManage
                  ? 'No repositories are watched yet.'
                  : hasConnection
                    ? 'None yet. Choose a repository above and select Watch.'
                    : 'None yet. Connect GitHub above, then choose a repository.'}
                <Link
                  className="ms-1 underline"
                  href="/docs/automate"
                  rel="noopener"
                  target="_blank"
                >
                  Read the guide
                </Link>
              </p>
            </Row>
          ) : (
            overview.data.sources.map((source) => (
              <SourceRow
                busy={busy}
                canManage={canManage}
                key={source.id}
                perform={perform}
                source={source}
              />
            ))
          )}
        </Group>
      </Section>
    </div>
  )
}

function SourceRow({
  busy,
  canManage,
  perform,
  source,
}: {
  busy: boolean
  canManage: boolean
  perform: (action: () => Promise<unknown>) => void
  source: Source
}) {
  const client = useTRPCClient()
  const [branch, setBranch] = useState(source.branch ?? '')
  const connected = source.connectionState === 'connected'
  const mode = (enabled: boolean, extra: { collectUnmatched?: boolean; branch?: string } = {}) =>
    perform(() => client.releaseAutomation.sourceMode.mutate({ id: source.id, enabled, ...extra }))
  return (
    <Row
      description={`${source.account || 'GitHub'} · ${
        source.mode === 'automation'
          ? 'Workflows handle its changes'
          : 'Changes go to the Release inbox'
      } · ${source.branch ? `PRs into ${source.branch}` : 'PRs into the default branch'}`}
      label={
        <span className="flex flex-wrap items-center gap-2">
          {source.name}
          <Pill tone={connected ? 'green' : 'yellow'}>
            {CONNECTION_LABELS[source.connectionState] ?? source.connectionState}
          </Pill>
        </span>
      }
      layout="stacked"
    >
      <ButtonLink href={`/workflows/sources/${source.id}/production`} variant="outline">
        Production policy and event history
      </ButtonLink>
      {!connected ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          Restore access in GitHub, reconnect GitHub above, and watch this repository again. Runs
          cancelled by the outage stay cancelled; history is kept.
        </p>
      ) : null}
      {canManage && connected ? (
        <div className="flex w-full flex-wrap items-end gap-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              mode(source.mode === 'automation', { branch: branch.trim() })
            }}
          >
            <Label className="grid gap-1 text-xs text-muted-foreground">
              Watched branch
              <Input
                aria-label={`Watched branch for ${source.name}`}
                className="h-9 w-40"
                onChange={(event) => setBranch(event.target.value)}
                placeholder="Default branch"
                value={branch}
              />
            </Label>
            <Button
              disabled={busy || branch === (source.branch ?? '')}
              size="sm"
              type="submit"
              variant="outline"
            >
              Save branch
            </Button>
          </form>
          <Label className="grid gap-1 text-xs text-muted-foreground">
            Merged PRs no workflow picks up
            <Select
              disabled={busy}
              value={source.collectUnmatched ? 'collect' : 'skip'}
              onValueChange={(nextValue) =>
                mode(source.mode === 'automation', { collectUnmatched: nextValue === 'collect' })
              }
            >
              <SelectTrigger
                aria-label={`Unmatched merged PRs for ${source.name}`}
                className="h-9 w-56"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="collect">Keep for the next release</SelectItem>
                <SelectItem value="skip">Skip them</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          <Button
            disabled={busy}
            onClick={() => mode(source.mode !== 'automation')}
            size="sm"
            type="button"
            variant="outline"
          >
            {source.mode === 'automation'
              ? 'Send changes to the Release inbox'
              : 'Let workflows handle releases'}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              window.confirm(`Stop watching ${source.name}? Pending runs will be cancelled.`) &&
              perform(() => client.releaseAutomation.disconnectSource.mutate({ id: source.id }))
            }
            size="sm"
            type="button"
            variant="destructive"
          >
            Stop watching {source.name}
          </Button>
        </div>
      ) : null}
    </Row>
  )
}

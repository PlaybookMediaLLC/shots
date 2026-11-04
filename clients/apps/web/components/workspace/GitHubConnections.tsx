'use client'

import { useSearchParams } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { githubChoiceStateSchema, githubChoicesParamSchema } from '@/lib/tenant/github-choices'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'
import {
  Select as UiSelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

type Connection = {
  accountLogin: string
  accountType: string
  id: string
  status: 'ACTIVE' | 'DELETED' | 'SUSPENDED'
}

type Repository = { defaultBranch: string; fullName: string; id: number; private: boolean }

/** What a return trip from GitHub tells the admin, keyed by the `github` search parameter. */
const OUTCOMES: Record<string, string> = {
  choose: 'Your GitHub account can reach several installations. Pick the one to link.',
  connected: 'GitHub is connected. Choose a repository to watch.',
  failed: 'GitHub could not be connected. Start again from this page.',
  none: 'No other installation of the GitHub App is available to link. Install it on an account first.',
  requested: 'An owner of the GitHub organization must approve the install first.',
  unavailable: 'This server has no GitHub App configured.',
}

const selectClass =
  'h-10 w-full rounded-lg border border-foreground/10 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/20'

/**
 * Connect GitHub App installations and select workspace repository sources.
 */
export function GitHubConnections() {
  const trpcClient = useTRPCClient()
  const searchParams = useSearchParams()
  const outcome = searchParams.get('github')
  const choices = githubChoicesParamSchema.safeParse(searchParams.get('choices') ?? '')
  const choiceState = githubChoiceStateSchema.safeParse(searchParams.get('state') ?? '')
  const [state, setState] = useState<{ configured: boolean; connections: Connection[] } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await trpcClient.github.connections.query())
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }, [trpcClient])

  useEffect(() => {
    void load()
  }, [load])

  async function disconnect(connectionId: string): Promise<void> {
    setError(null)
    try {
      await trpcClient.github.disconnect.mutate({ connectionId })
      await load()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }

  return (
    <Section
      description="Connect an installation and choose repositories. Legacy intake holds merged PRs for a published release; Release Automation can define a different release trigger."
      title="GitHub"
    >
      {outcome && OUTCOMES[outcome] ? (
        <Alert className="mb-4">
          <AlertDescription>{OUTCOMES[outcome]}</AlertDescription>
        </Alert>
      ) : null}
      <Group>
        {state === null ? (
          <Row>
            <p className="text-sm text-muted-foreground">Loading GitHub connections…</p>
          </Row>
        ) : !state.configured ? (
          <Row>
            <p className="text-sm text-muted-foreground">{OUTCOMES.unavailable}</p>
          </Row>
        ) : (
          <>
            {state.connections.length === 0 ? (
              <Row>
                <p className="text-sm text-muted-foreground">
                  No GitHub installation is connected to this workspace.
                </p>
              </Row>
            ) : null}
            {state.connections.map((connection) => (
              <ConnectionRow
                connection={connection}
                key={connection.id}
                onDisconnect={() => void disconnect(connection.id)}
              />
            ))}
            {outcome === 'choose' && choices.success && choiceState.success ? (
              <Row label="Choose the GitHub account to link">
                <div className="flex flex-wrap gap-2">
                  {choices.data.map((choice) => (
                    <Button
                      asChild
                      className="rounded-lg"
                      key={choice.id}
                      size="sm"
                      variant="outline"
                    >
                      <a
                        href={`/integrations/github/choose?${new URLSearchParams({
                          installation_id: String(choice.id),
                          state: choiceState.data,
                        })}`}
                      >
                        Link {choice.accountLogin}
                      </a>
                    </Button>
                  ))}
                </div>
              </Row>
            ) : null}
            <Row
              description="Install the GitHub App on the repositories you want to watch, or link an installation you already have."
              label="Connect a GitHub account or organization"
              layout="inline"
            >
              <div className="flex flex-wrap gap-2">
                <Button asChild className="rounded-lg" size="sm">
                  <a href="/integrations/github/start">Connect GitHub</a>
                </Button>
                <Button asChild className="rounded-lg" size="sm" variant="outline">
                  <a href="/integrations/github/start?existing=1">Link existing installation</a>
                </Button>
              </div>
            </Row>
          </>
        )}
      </Group>
      {error ? (
        <Alert className="mt-4" variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </Section>
  )
}

function ConnectionRow({
  connection,
  onDisconnect,
}: {
  connection: Connection
  onDisconnect: () => void
}) {
  const trpcClient = useTRPCClient()
  const [repositories, setRepositories] = useState<Repository[] | null>(null)
  const [watched, setWatched] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const repository = repositories?.find((candidate) => String(candidate.id) === selected)

  async function loadRepositories(): Promise<void> {
    setError(null)
    try {
      const [result, overview] = await Promise.all([
        trpcClient.github.repositories.query({ connectionId: connection.id }),
        trpcClient.releaseAutomation.overview.query().catch(() => null),
      ])
      setWatched(
        (overview?.sources ?? [])
          .filter((source) => source.connectionState === 'connected')
          .map((source) => source.repositoryId)
      )
      setRepositories(result.repositories)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }

  async function watch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!repository || watched.includes(String(repository.id))) return
    setBusy(true)
    setError(null)
    try {
      await trpcClient.sourceApp.create.mutate({
        allowedHosts: ['https://api.github.com'],
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        externalId: String(repository.id),
        githubConnectionId: connection.id,
        name: repository.fullName,
        provider: 'github',
      })
      setMessage(
        `Watching ${repository.fullName}. New sources import recent history without running marketing workflows. Reconnected sources keep their existing rules and history.`
      )
      setWatched((items) => [...items, String(repository.id)])
      setSelected('')
      setBranch('')
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Row>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-ui-lg font-medium text-foreground">{connection.accountLogin}</span>
          <Pill tone={connection.status === 'ACTIVE' ? 'green' : 'yellow'}>
            {connection.status.toLowerCase()}
          </Pill>
        </div>
        <Button
          onClick={() => {
            if (
              window.confirm(
                `Disconnect ${connection.accountLogin}? Its repositories will stop receiving events in this workspace.`
              )
            )
              onDisconnect()
          }}
          size="sm"
          type="button"
          variant="destructive"
        >
          Disconnect {connection.accountLogin}
        </Button>
      </div>
      {connection.status !== 'ACTIVE' ? (
        <p className="text-sm text-amber-600">
          {connection.status === 'SUSPENDED'
            ? 'Resume this installation in GitHub, then reconnect it here.'
            : 'Install or link the GitHub App again, then select the repository to restore access.'}
        </p>
      ) : null}
      {connection.status !== 'ACTIVE' ? null : repositories === null ? (
        <div>
          <Button onClick={() => void loadRepositories()} size="sm" type="button" variant="outline">
            Choose a repository
          </Button>
        </div>
      ) : (
        <form className="grid gap-3 sm:grid-cols-[1fr_12rem_auto]" onSubmit={watch}>
          <UiSelect
            onValueChange={(nextValue) =>
              setSelected(nextValue === '__empty_option__' ? '' : nextValue)
            }
            value={String(selected) || '__empty_option__'}
          >
            <SelectTrigger aria-label="Repository" className={selectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={'__empty_option__'}>Select a repository</SelectItem>
              {repositories.map((candidate) => (
                <SelectItem
                  disabled={watched.includes(String(candidate.id))}
                  key={candidate.id}
                  value={String(candidate.id)}
                >
                  {candidate.fullName}
                  {watched.includes(String(candidate.id)) ? ' (already watched)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </UiSelect>
          <Input
            aria-label="Branch to watch"
            className="h-10 rounded-lg"
            onChange={(event) => setBranch(event.target.value)}
            placeholder={repository ? repository.defaultBranch : 'Default branch'}
            value={branch}
          />
          <Button
            className="rounded-lg"
            disabled={!repository || busy || watched.includes(String(repository.id))}
            type="submit"
          >
            {busy ? 'Watching…' : 'Watch'}
          </Button>
        </form>
      )}
      {message ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p> : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    </Row>
  )
}

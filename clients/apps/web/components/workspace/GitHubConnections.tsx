'use client'

import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { safeReturnPath } from '@/lib/platform/navigation'
import { githubChoiceStateSchema, githubChoicesParamSchema } from '@/lib/tenant/github-choices'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { connectedSources } from '@/lib/workflows/actions'
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

/** What a return trip from GitHub tells the admin, keyed by the `github` search parameter. */
const OUTCOMES: Record<string, string> = {
  choose: 'The Shots GitHub App is on several accounts you can reach. Pick the one to link.',
  connected: 'GitHub is connected. Choose a repository to watch.',
  failed: 'GitHub could not be connected. Start again from this page.',
  none: 'The Shots GitHub App is not on another account you can reach. Install it on one first.',
  requested: 'An owner of the GitHub organization must approve the install first.',
  unavailable: 'This server has no GitHub App configured.',
}

/** The page to reopen once GitHub is connected; GitHub itself always returns to Repositories. */
const GITHUB_RETURN_KEY = 'shots:github-return'

const selectClass =
  'h-10 w-full rounded-lg border border-foreground/10 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/20'

/** Whether GitHub is connected: Repositories, the template flow and the setup list read one answer. */
export function useGitHubConnections(enabled = true) {
  const trpc = useTRPC()
  return useQuery(trpc.github.connections.queryOptions(undefined, { enabled }))
}

/** The GitHub section of Repositories and developer settings. */
export function GitHubConnections() {
  return (
    <Section
      description="Connect the GitHub account that owns your code, then choose which repositories to watch."
      title="GitHub"
    >
      <GitHubSetup />
    </Section>
  )
}

/**
 * Connect GitHub and watch repositories. With `returnTo`, it is one step in
 * another flow: a return trip from GitHub comes back there.
 */
export function GitHubSetup({ returnTo }: { returnTo?: string }) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const router = useRouter()
  const searchParams = useSearchParams()
  const outcome = searchParams.get('github')
  const choices = githubChoicesParamSchema.safeParse(searchParams.get('choices') ?? '')
  const choiceState = githubChoiceStateSchema.safeParse(searchParams.get('state') ?? '')
  const github = useGitHubConnections()
  const disconnect = useMutation({
    mutationFn: (connectionId: string) => trpcClient.github.disconnect.mutate({ connectionId }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.github.connections.queryKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.releaseAutomation.overview.queryKey() }),
      ]),
  })

  useEffect(() => {
    if (outcome !== 'connected') return
    try {
      const target = sessionStorage.getItem(GITHUB_RETURN_KEY)
      sessionStorage.removeItem(GITHUB_RETURN_KEY)
      if (target) router.replace(safeReturnPath(target, '/workflows/new'))
    } catch {
      // Without browser storage the person stays on Repositories, where they can continue.
    }
  }, [outcome, router])

  const failure = github.error ?? disconnect.error
  const connections = github.data?.connections ?? []
  const connect = <ConnectGitHub returnTo={returnTo} />
  return (
    <>
      {outcome && OUTCOMES[outcome] ? (
        <Alert className="mb-4">
          <AlertDescription>{OUTCOMES[outcome]}</AlertDescription>
        </Alert>
      ) : null}
      <Group>
        {!github.data ? (
          <Row>
            <p className="text-sm text-muted-foreground">
              {github.error ? 'GitHub connections could not load.' : 'Loading GitHub connections…'}
            </p>
          </Row>
        ) : !github.data.configured ? (
          <Row>
            <p className="text-sm text-muted-foreground">{OUTCOMES.unavailable}</p>
          </Row>
        ) : (
          <>
            {connections.map((connection) => (
              <ConnectionRow
                connection={connection}
                key={connection.id}
                onDisconnect={() => disconnect.mutate(connection.id)}
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
                  <Button asChild className="rounded-lg" size="sm" variant="ghost">
                    <a href="/integrations/github/start?install=1">Install on another account</a>
                  </Button>
                </div>
              </Row>
            ) : null}
            {connections.length === 0 ? (
              connect
            ) : returnTo ? null : (
              <Row>
                <Disclosure>
                  <DisclosureTrigger>Add another GitHub account</DisclosureTrigger>
                  <DisclosureContent>{connect}</DisclosureContent>
                </Disclosure>
              </Row>
            )}
          </>
        )}
      </Group>
      {failure ? (
        <Alert className="mt-4" variant="destructive">
          <AlertDescription>{getErrorMessage(failure)}</AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}

/** One way in: GitHub shows what this person can reach, then Shots links it or asks them to install. */
function ConnectGitHub({ returnTo }: { returnTo?: string }) {
  const remember = () => {
    try {
      if (returnTo) sessionStorage.setItem(GITHUB_RETURN_KEY, returnTo)
      else sessionStorage.removeItem(GITHUB_RETURN_KEY)
    } catch {
      // Without browser storage GitHub still returns to Repositories.
    }
  }
  return (
    <Row
      description="Sign in to GitHub. If the Shots GitHub App is already on your account, Shots links it. If not, GitHub asks you to install it."
      label="Connect a GitHub account or organization"
    >
      <Button asChild className="rounded-lg" size="sm">
        <a href="/integrations/github/start" onClick={remember}>
          Connect GitHub
        </a>
      </Button>
    </Row>
  )
}

function ConnectionRow({
  connection,
  onDisconnect,
}: {
  connection: Connection
  onDisconnect: () => void
}) {
  const trpc = useTRPC()
  const overview = useQuery(trpc.releaseAutomation.overview.queryOptions())
  const [confirming, setConfirming] = useState(false)
  const sourceIds = (overview.data?.sources ?? [])
    .filter((source) => source.account === connection.accountLogin)
    .map((source) => source.id)
  const stopping = (overview.data?.definitions ?? []).filter(
    (definition) => definition.enabled && sourceIds.includes(definition.sourceAppId)
  )
  return (
    <Row>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-ui-lg font-medium text-foreground [overflow-wrap:anywhere]">
            {connection.accountLogin}
          </span>
          <Pill tone={connection.status === 'ACTIVE' ? 'green' : 'yellow'}>
            {connection.status.toLowerCase()}
          </Pill>
        </div>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`Options for ${connection.accountLogin}`}
              size="icon"
              type="button"
              variant="ghost"
            >
              <DotsThreeIcon aria-hidden="true" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="platform-overlay">
            <DropdownMenuItem onSelect={() => setConfirming(true)} variant="destructive">
              Disconnect {connection.accountLogin}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        <AlertDialogContent>
          <AlertDialogTitle>Disconnect {connection.accountLogin}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its repositories stop sending events to this workspace.{' '}
            {stopping.length
              ? `These active workflows stop: ${stopping.map((item) => item.name).join(', ')}.`
              : overview.data
                ? 'No active workflow uses it.'
                : 'Any active workflow using it stops.'}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={onDisconnect}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {connection.status !== 'ACTIVE' ? (
        <p className="text-sm text-amber-600">
          {connection.status === 'SUSPENDED'
            ? 'Resume the Shots GitHub App in GitHub, then reconnect it here.'
            : 'Install or link the GitHub App again, then select the repository to restore access.'}
        </p>
      ) : (
        <WatchRepositoryForm connection={connection} />
      )}
    </Row>
  )
}

/** Choose a repository the installation can read and start watching it. */
function WatchRepositoryForm({ connection }: { connection: Connection }) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const overview = useQuery(trpc.releaseAutomation.overview.queryOptions())
  const repositories = useQuery(
    trpc.github.repositories.queryOptions({ connectionId: connection.id })
  )
  const [selected, setSelected] = useState('')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const watched = overview.data
    ? connectedSources(overview.data).map((source) => source.repositoryId)
    : []
  const available = (repositories.data?.repositories ?? []).filter(
    (candidate) => !watched.includes(String(candidate.id))
  )
  // The one repository left to watch is the obvious choice.
  const choice = selected || (available.length === 1 ? String(available[0]?.id) : '')
  const repository = available.find((candidate) => String(candidate.id) === choice)

  async function watch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!repository) return
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
        `Watching ${repository.fullName}. Its recent history is imported without running any workflow.`
      )
      setSelected('')
      setBranch('')
      await queryClient.invalidateQueries({
        queryKey: trpc.releaseAutomation.overview.queryKey(),
      })
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  if (repositories.error) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-red-700 dark:text-red-300">
          {getErrorMessage(repositories.error)}
        </p>
        <Button onClick={() => void repositories.refetch()} size="sm" variant="outline">
          Try again
        </Button>
      </div>
    )
  }
  if (!repositories.data) {
    return <p className="text-sm text-muted-foreground">Loading repositories…</p>
  }
  return (
    <>
      {repositories.data.repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The Shots GitHub App cannot read any repositories on this account yet. Give it access to
          one in GitHub, then come back.
        </p>
      ) : (
        <form
          className="grid gap-3 @min-[36rem]/platform-group:grid-cols-[1fr_12rem_auto] @min-[36rem]/platform-group:items-end"
          onSubmit={watch}
        >
          <Label className="grid gap-1.5 text-sm">
            Repository
            <UiSelect
              onValueChange={(nextValue) =>
                setSelected(nextValue === '__empty_option__' ? '' : nextValue)
              }
              value={choice || '__empty_option__'}
            >
              <SelectTrigger aria-label="Repository" className={selectClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={'__empty_option__'}>Select a repository</SelectItem>
                {repositories.data.repositories.map((candidate) => {
                  const taken = watched.includes(String(candidate.id))
                  return (
                    <SelectItem disabled={taken} key={candidate.id} value={String(candidate.id)}>
                      {candidate.fullName}
                      {taken ? ' (already watched)' : ''}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </UiSelect>
          </Label>
          <Label className="grid gap-1.5 text-sm">
            Branch (optional)
            <Input
              aria-label="Branch to watch"
              className="h-10 rounded-lg"
              onChange={(event) => setBranch(event.target.value)}
              placeholder={repository ? repository.defaultBranch : 'Default branch'}
              value={branch}
            />
          </Label>
          <Button className="rounded-lg" disabled={!repository || busy} type="submit">
            {busy ? 'Watching…' : 'Watch'}
          </Button>
        </form>
      )}
      {!repository && available.length > 0 ? (
        <p className="text-xs text-muted-foreground">Pick a repository to enable Watch.</p>
      ) : null}
      {message ? (
        <p className="text-sm text-emerald-700 dark:text-emerald-300">
          {message}{' '}
          <Link className="underline" href="/workflows/new">
            Choose a template
          </Link>
        </p>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
    </>
  )
}

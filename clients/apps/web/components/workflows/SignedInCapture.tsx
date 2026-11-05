'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LockKeyIcon } from '@phosphor-icons/react/dist/ssr/LockKey'
import { EmptyState } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { useTRPC } from '@/lib/trpc/react'
import { captureInProgress } from '@/lib/workflows/capture'
import { CaptureConnections } from './CaptureConnections'
import { CaptureJobs } from './CaptureJobs'
import { CaptureRecipes } from './CaptureRecipes'

/** Connections, recipes and jobs for screens behind a sign-in. Go re-checks every action. */
export function SignedInCapture({ canManage }: { canManage: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const capture = useQuery(
    trpc.capture.overview.queryOptions(undefined, {
      refetchInterval: (query) =>
        query.state.data && captureInProgress(query.state.data) ? 5_000 : 30_000,
    })
  )
  const automation = useQuery(trpc.releaseAutomation.overview.queryOptions())
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.capture.overview.queryKey() })
  const problem = capture.error ?? automation.error
  if (problem) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{getErrorMessage(problem)}</AlertDescription>
      </Alert>
    )
  }
  if (!capture.data) return <p className="text-sm text-muted-foreground">Loading…</p>
  const { available, connections, jobs, recipes } = capture.data
  return (
    <div className="space-y-8">
      {available ? null : (
        <EmptyState
          action={
            canManage ? (
              <Disclosure className="text-start text-sm">
                <DisclosureTrigger>How to set it up</DisclosureTrigger>
                <DisclosureContent>
                  <ol className="mt-2 list-decimal space-y-1 ps-5 text-muted-foreground">
                    <li>
                      Point the server at a browser provider with PLATFORM_CAPTURE_CDP_URL and
                      PLATFORM_CAPTURE_CDP_TOKEN.
                    </li>
                    <li>Set PLATFORM_CAPTURE_STATE_KEY, which encrypts saved sign-ins.</li>
                    <li>Restart the server, then connect a sign-in on this page.</li>
                  </ol>
                </DisclosureContent>
              </Disclosure>
            ) : null
          }
          description={
            canManage
              ? 'Whoever runs this Shots server turns it on. Public product pages can still be captured.'
              : 'A workspace owner or admin can ask to have it turned on. Public product pages can still be captured.'
          }
          icon={LockKeyIcon}
          title="Signed-in capture is not set up"
        />
      )}
      {available || connections.length > 0 ? (
        <>
          <CaptureConnections
            canManage={canManage}
            connections={connections}
            onChanged={refresh}
            sources={automation.data?.sources ?? []}
          />
          <CaptureRecipes
            canManage={canManage}
            connections={connections}
            jobs={jobs}
            onChanged={refresh}
            recipes={recipes}
            surfaces={automation.data?.surfaces ?? []}
          />
          <CaptureJobs canManage={canManage} jobs={jobs} onChanged={refresh} recipes={recipes} />
        </>
      ) : null}
    </div>
  )
}

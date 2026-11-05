'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { AutomateIcon } from '@/components/platform-shell/icons'
import { EmptyState, Page } from '@/components/platform-ui'
import { getErrorMessage } from '@/components/workspace/settings-client'
import type {
  AutomationDefinition,
  AutomationHistoryItem,
  AutomationOverview,
} from '@/lib/api/contracts/release-automation'
import { useTRPCClient } from '@/lib/trpc/react'
import { WorkflowEditor } from './WorkflowEditor'

/** Loads one persisted definition into the editor at its own URL. */
export function WorkflowDefinitionEditor({ canManage, id }: { canManage: boolean; id: string }) {
  const client = useTRPCClient()
  const router = useRouter()
  const params = useSearchParams()
  const copy = params.get('copy') === '1'
  const [state, setState] = useState<{
    key: string
    definition: AutomationDefinition
    history: AutomationHistoryItem[]
    overview: AutomationOverview
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const overview = await client.releaseAutomation.overview.query()
        const definition = overview.definitions.find((candidate) => candidate.id === id)
        if (!definition) {
          if (!cancelled) setMissing(true)
          return
        }
        const history = await client.releaseAutomation.history.query({
          sourceAppId: definition.sourceAppId,
          family: definition.draft.family,
        })
        if (cancelled) return
        setError(null)
        setMissing(false)
        setState({
          key: `${id}:${copy}`,
          definition: copy
            ? {
                ...definition,
                id: '',
                name: `${definition.name} (copy)`.slice(0, 160),
                revision: 0,
                enabled: false,
                archived: false,
                activeVersionId: null,
                lastRun: null,
                recentRuns: 0,
                updatedAt: '',
              }
            : definition,
          history: history.items,
          overview,
        })
      } catch (failure) {
        if (!cancelled) setError(getErrorMessage(failure))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, id, copy])

  useEffect(() => {
    const refresh = () => {
      void client.releaseAutomation.overview
        .query()
        .then((overview) =>
          setState((previous) => (previous ? { ...previous, overview } : previous))
        )
        .catch((failure) => setError(getErrorMessage(failure)))
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [client])

  if (!state || state.key !== `${id}:${copy}`) {
    if (missing)
      return (
        <Page title="Workflow not found">
          <EmptyState
            action={
              <>
                <ButtonLink href="/workflows">All workflows</ButtonLink>
                <ButtonLink href="/workflows/runs" variant="outline">
                  Runs
                </ButtonLink>
              </>
            }
            description="This workflow does not exist in this workspace. It may be in another workspace, or the link may be wrong."
            icon={AutomateIcon}
            title="We could not find this workflow"
          />
        </Page>
      )
    return (
      <Page
        actions={
          <ButtonLink href="/workflows" variant="outline">
            All workflows
          </ButtonLink>
        }
        title="Workflow"
      >
        <p
          className={error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}
          role={error ? 'alert' : 'status'}
        >
          {error ?? 'Loading workflow…'}
        </p>
      </Page>
    )
  }
  return (
    <WorkflowEditor
      presentation="page"
      key={`${id}:${copy}`}
      initialNode={params.get('node') ?? undefined}
      definition={state.definition}
      history={state.history}
      onClose={() => router.push('/workflows')}
      onSaved={(saved) => {
        if (copy) router.replace(`/workflows/${saved.id}`)
      }}
      overview={state.overview}
      readOnly={!canManage || !!state.definition.archived}
      startsDirty={copy}
    />
  )
}

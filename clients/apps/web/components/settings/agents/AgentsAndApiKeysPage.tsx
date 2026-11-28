'use client'

import { Plus } from '@phosphor-icons/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { WebhookSettings } from '@/components/settings/WebhookSettings'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { SITE_URL } from '@/lib/seo/metadata'
import { useTRPCClient } from '@/lib/trpc/react'
import { ApiDocsCard } from './ApiDocsCard'
import { ApiKeysCard } from './ApiKeysCard'
import { ConnectAgentHub } from './ConnectAgentHub'
import { ConnectedAgentsCard } from './ConnectedAgentsCard'
import { CreateApiKeyDialog, type CreateApiKeyPayload } from './CreateApiKeyDialog'
import {
  type ConnectedAgentGroup,
  groupConnectedAgents,
  type WorkspaceCredential,
} from './scope-summary'

const EMPTY_KEYS: WorkspaceCredential[] = []

/**
 * Unified "Agents & API keys" settings experience:
 * 1. Connected agents (OAuth-only, grouped multi-session + Revoke / Revoke all)
 * 2. API keys (REST/CLI only, modal "+ Create API key")
 * 3. Connect an AI agent (13-client OAuth-first hub + "Give this guide" Markdown)
 * 4. Outbound webhooks (quick setup + full delivery management)
 * 5. API Documentation card
 */
export function AgentsAndApiKeysPage({
  canManageKeys,
  canManageWebhooks,
  mcpUrl,
  organizationId,
}: {
  canManageKeys: boolean
  canManageWebhooks: boolean
  mcpUrl: string
  organizationId: string
}) {
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const keysQueryKey = useMemo(() => ['workspace-api-keys', organizationId] as const, [organizationId])
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [origin, setOrigin] = useState(SITE_URL)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.origin) {
      setOrigin(window.location.origin)
    }
  }, [])

  const keysQuery = useQuery({
    enabled: canManageKeys,
    queryFn: async (): Promise<WorkspaceCredential[]> => {
      const result = await trpcClient.apiKey.list.query()
      return result.keys
    },
    queryKey: keysQueryKey,
  })

  const keys = keysQuery.data ?? EMPTY_KEYS
  const error = mutationError ?? (keysQuery.error ? getErrorMessage(keysQuery.error) : null)
  const connectedGroups = useMemo(() => groupConnectedAgents(keys), [keys])
  const restApiKeys = useMemo(() => keys.filter((key) => key.agentSession === null), [keys])

  async function refreshKeys(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: keysQueryKey })
  }

  async function handleCreateKey(payload: CreateApiKeyPayload): Promise<boolean> {
    setMutationError(null)
    setPendingId('create')
    try {
      const result = await trpcClient.apiKey.create.mutate(payload)
      setNewKey(result.apiKey.key)
      await refreshKeys()
      toast.success('API key created. Copy it now — it will not be shown again.')
      return true
    } catch (requestError) {
      const message = getErrorMessage(requestError)
      setMutationError(message)
      toast.error(message)
      return false
    } finally {
      setPendingId(null)
    }
  }

  async function handleRevokeSessionOrKey(keyId: string): Promise<string | null> {
    setMutationError(null)
    setPendingId(keyId)
    try {
      await trpcClient.apiKey.revoke.mutate({ keyId })
      await refreshKeys()
      toast.success('Access revoked.')
      return null
    } catch (requestError) {
      const message = getErrorMessage(requestError)
      setMutationError(message)
      return message
    } finally {
      setPendingId(null)
    }
  }

  async function handleRevokeGroup(group: ConnectedAgentGroup): Promise<string | null> {
    setMutationError(null)
    setPendingId(group.groupKey)
    try {
      const result = await trpcClient.apiKey.revokeAgentClient.mutate({
        clientId: group.clientId || undefined,
        clientName: group.clientName,
      })
      await refreshKeys()
      toast.success(
        `Revoked ${result.revokedCount} ${result.revokedCount === 1 ? 'session' : 'sessions'} for ${group.clientName}.`
      )
      return null
    } catch (requestError) {
      const message = getErrorMessage(requestError)
      setMutationError(message)
      return message
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      {canManageKeys ? (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)} type="button">
            <Plus aria-hidden="true" className="mr-1.5 size-4" />
            Create API key
          </Button>
        </div>
      ) : (
        <Alert>
          <AlertDescription>
            Ask a workspace owner or admin to connect an AI agent, create API keys, or revoke
            sessions.
          </AlertDescription>
        </Alert>
      )}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {canManageKeys ? (
        <>
          <ConnectedAgentsCard
            groups={connectedGroups}
            isLoading={keysQuery.isPending}
            onRevokeGroup={handleRevokeGroup}
            onRevokeSession={handleRevokeSessionOrKey}
            pendingId={pendingId}
          />
          <ApiKeysCard
            isLoading={keysQuery.isPending}
            keys={restApiKeys}
            newKey={newKey}
            onCreateClick={() => setCreateOpen(true)}
            onDismissNewKey={() => setNewKey(null)}
            onRevoke={handleRevokeSessionOrKey}
            pendingId={pendingId}
          />
        </>
      ) : null}

      <ConnectAgentHub
        apiKey={newKey}
        canCreateKey={canManageKeys}
        mcpUrl={mcpUrl}
        onOpenCreateKey={() => setCreateOpen(true)}
        origin={origin}
      />

      <WebhookSettings
        canManage={canManageWebhooks}
        quickSetup
        returnFrom="/settings/ai-agents"
      />

      <ApiDocsCard />

      {canManageKeys ? (
        <CreateApiKeyDialog
          isSubmitting={pendingId === 'create'}
          onCreate={handleCreateKey}
          onOpenChange={setCreateOpen}
          open={createOpen}
        />
      ) : null}
    </div>
  )
}

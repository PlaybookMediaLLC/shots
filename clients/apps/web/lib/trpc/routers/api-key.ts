import 'server-only'

import { z } from 'zod'
import { permissionsForApiKeyScopes, scopesFromPermissions } from '@/lib/auth/api-key-scopes'
import { auth } from '@/lib/auth/server'
import { backendSDK, serviceBackend, withDates } from '@/lib/backend/sdk'
import {
  workspaceApiKeyDeleteSchema,
  workspaceApiKeySchema,
} from '@/lib/tenant/workspace-settings-schema'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

const dayInSeconds = 24 * 60 * 60

const agentKeyMetadataSchema = z.object({
  clientId: z.string().trim().nullish(),
  clientName: z.string().trim().nullish(),
  grantId: z.string().trim().nullish(),
  source: z.literal('agent'),
})

const revokeAgentClientInputSchema = z
  .object({
    clientId: z.string().trim().max(200).optional(),
    clientName: z.string().trim().max(200).optional(),
  })
  .refine((value) => Boolean(value.clientId || value.clientName), {
    message: 'Specify the connected agent to revoke.',
  })

/** Structured OAuth session identity stored on agent-issued workspace keys (RFC 026). */
export type AgentSessionInfo = {
  clientId: string
  clientName: string
  grantId: string | null
}

/** An agent connected through OAuth keeps its client's identity in key metadata (RFC 026). */
function agentSessionOf(metadata: unknown): AgentSessionInfo | null {
  try {
    const raw: unknown = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
    const parsed = agentKeyMetadataSchema.safeParse(raw)
    if (!parsed.success) return null
    const clientName = parsed.data.clientName || 'AI agent'
    return {
      clientId: parsed.data.clientId || '',
      clientName,
      grantId: parsed.data.grantId || null,
    }
  } catch {
    // Metadata Better Auth wrote for other keys is not ours to read.
    return null
  }
}

export const apiKeyRouter = router({
  list: organizationProcedure('brand:manage').query(async ({ ctx }) => {
    const { rows } = await serviceBackend().authStore({
      model: 'apikey',
      op: 'findMany',
      select: [
        'createdAt',
        'enabled',
        'expiresAt',
        'id',
        'lastRequest',
        'metadata',
        'name',
        'permissions',
        'prefix',
        'start',
      ],
      sortBy: { direction: 'desc', field: 'createdAt' },
      where: [{ field: 'referenceId', value: ctx.access.organizationId }],
    })
    const keys = withDates(
      (rows ?? []) as {
        createdAt: string
        enabled: boolean | null
        expiresAt: string | null
        id: string
        /** When the key last authenticated a request, where it is recorded. */
        lastRequest: string | null
        metadata: unknown
        name: string | null
        permissions: unknown
        prefix: string | null
        start: string | null
      }[]
    ).map(({ metadata, permissions, ...key }) => {
      const agentSession = agentSessionOf(metadata)
      return {
        ...key,
        agentClient: agentSession?.clientName ?? null,
        agentSession,
        scopes: scopesFromPermissions(permissions),
      }
    })
    return { keys }
  }),
  create: organizationProcedure('brand:manage')
    .input(workspaceApiKeySchema)
    .mutation(async ({ ctx, input }) => {
      const apiKey = await auth.api.createApiKey({
        body: {
          expiresIn: input.expiresInDays ? input.expiresInDays * dayInSeconds : null,
          name: input.name,
          organizationId: ctx.access.organizationId,
          permissions: permissionsForApiKeyScopes(input.scopes),
          userId: ctx.access.principal.userId,
        },
      })
      await backendSDK(ctx.access).appendAuditEvent({
        action: 'product.api_key_created',
        entityId: apiKey.id,
        entityType: 'api_key',
      })
      return { apiKey }
    }),
  revoke: organizationProcedure('brand:manage')
    .input(workspaceApiKeyDeleteSchema)
    .mutation(async ({ ctx, input }) => {
      // Scoped to the workspace: another workspace's key id deletes nothing.
      const { count } = await serviceBackend().authStore({
        model: 'apikey',
        op: 'deleteMany',
        where: [
          { field: 'id', value: input.keyId },
          { field: 'referenceId', value: ctx.access.organizationId },
        ],
      })
      if (count) {
        await backendSDK(ctx.access).appendAuditEvent({
          action: 'product.api_key_revoked',
          entityId: input.keyId,
          entityType: 'api_key',
        })
      }
      return { success: true as const }
    }),
  revokeAgentClient: organizationProcedure('brand:manage')
    .input(revokeAgentClientInputSchema)
    .mutation(async ({ ctx, input }) => backendSDK(ctx.access).revokeAgentClient(input)),
})

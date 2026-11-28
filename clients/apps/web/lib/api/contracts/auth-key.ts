import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { isoInstantSchema } from '@/lib/api/contracts/settings-platform'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'

/** Redacted summary of the authenticated workspace API key. */
export const currentApiKeySummarySchema = z.object({
  expiresAt: isoInstantSchema.nullable(),
  id: z.string(),
  name: z.string().nullable(),
  prefix: z.string().nullable(),
  scopes: z.array(z.string()),
  start: z.string().nullable(),
})

/** Brief identity of the workspace an API key belongs to. */
export const currentApiKeyWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
})

/** Response payload for `GET /api/v1/auth/me`. */
export const currentApiKeyInfoSchema = z.object({
  key: currentApiKeySummarySchema,
  workspace: currentApiKeyWorkspaceSchema,
})

/** `GET /api/v1/auth/me`: verifies an API key and returns its workspace and granted scopes. */
export const getCurrentKeyInfoContract = defineContract({
  access: {
    apiKeyOnly: true,
    feature: 'workspace:paid',
  },
  docs: workspaceDocs({
    description:
      'Verifies the calling workspace API key and returns redacted key metadata, granted scopes, and workspace identity. Useful for CLI setup and integration health checks.',
    operationId: 'getCurrentKeyInfo',
    outputName: 'CurrentKeyInfoResponse',
    responses: {
      '200': 'Redacted API key summary and workspace identity.',
      '401': 'The API key is missing, invalid, disabled, or expired.',
      '403': 'The credential is not a workspace API key or lacks workspace access.',
    },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'auth.key-info',
  output: currentApiKeyInfoSchema,
  path: '/api/v1/auth/me',
  summary: 'Verify the calling workspace API key',
})

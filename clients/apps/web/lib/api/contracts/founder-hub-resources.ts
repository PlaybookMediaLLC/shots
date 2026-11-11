import { z } from 'zod'
import {
  founderHubResourceActionSchema,
  founderHubResourceResultSchema,
  founderHubShareWorkspaceSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'

/** Preserve the shared library's owner, workspace and named-guest boundaries in Shots. */
export const founderHubResourceActionContract = defineContract({
  method: 'POST',
  name: 'founder-hub.resources.action',
  path: '/api/founder-hub/resources',
  summary: 'Manage a Founder Hub shared resource',
  body: founderHubResourceActionSchema,
  output: founderHubResourceResultSchema,
})
/** List current workspaces for the resource-sharing picker. */
export const founderHubShareWorkspacesContract = defineContract({
  method: 'GET',
  name: 'founder-hub.resources.workspaces',
  path: '/api/founder-hub/resources/workspaces',
  summary: 'Read Founder Hub library workspaces',
  output: z.array(founderHubShareWorkspaceSchema),
})

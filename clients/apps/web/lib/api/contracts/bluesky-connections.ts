import {
  blueskyConnectionBeginSchema,
  blueskyConnectionBeginResponseSchema,
  blueskyConnectionCompleteSchema,
  blueskyConnectionCompleteResponseSchema,
} from 'screenshot-studio-backend-sdk'
import type { ScreenshotStudioBackendSDK } from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'
import { memberDocs } from '@/lib/api/contracts/workspace-docs'

const access = {
  permission: 'workspace:update',
  feature: 'content:drafts',
  quota: 'api:write:minute',
  sensitive: 'connection',
} as const

/** Start an original-workspace Bluesky credential attempt without a password. */
export const beginBlueskyConnectionContract = defineContract({
  access,
  body: blueskyConnectionBeginSchema,
  docs: memberDocs({
    bodyName: 'BlueskyConnectionBeginRequest',
    outputName: 'BlueskyConnectionBeginResponse',
    description:
      'Creates a single-use, session-bound Bluesky connection attempt for an owner or admin. No social set is created yet. Reconnect retains the original account identity. Each call creates a new attempt; do not retry a lost begin response automatically. API keys cannot connect accounts.',
    operationId: 'beginBlueskyConnection',
    tag: 'Publishing',
    responses: {
      '201': 'A persisted credential attempt.',
      '400': 'Invalid ownership or connection target.',
      '404': 'The target is unavailable to this person.',
      '409': 'The provider slot, account or plan conflicts.',
      '429': 'The write quota is exhausted.',
      '503': 'Bluesky connections are unavailable.',
    },
  }),
  method: 'POST',
  name: 'bluesky-connections.begin',
  output: mirrors<Awaited<ReturnType<ScreenshotStudioBackendSDK['beginBlueskyConnection']>>>()(
    blueskyConnectionBeginResponseSchema
  ),
  path: '/api/v1/bluesky-connection-attempts',
  status: 201,
  summary: 'Start a Bluesky connection',
})

/** Submit an app password once; subsequent recovery sends only the attempt state. */
export const completeBlueskyConnectionContract = defineContract({
  access,
  body: blueskyConnectionCompleteSchema,
  docs: memberDocs({
    bodyName: 'BlueskyConnectionCompleteRequest',
    outputName: 'BlueskyConnectionCompleteResponse',
    description:
      'Verifies a dedicated app password and commits the account to the original authorized social set. Credentials belong only in this POST body and must never be logged or persisted by clients. Omit credentials to recover a saved result after interruption. An uncertain external exchange returns a conflict and is not automatically retried. The backend rechecks the original session, workspace and target before committing.',
    operationId: 'completeBlueskyConnection',
    tag: 'Publishing',
    responses: {
      '200': 'Verified account and social-set association completed or recovered.',
      '400': 'Invalid handle, app-password format or state.',
      '403': 'The original session or authority is no longer valid.',
      '404': 'The original target is no longer available.',
      '409': 'Account mismatch, ownership conflict or uncertain external result.',
      '429': 'The write quota is exhausted.',
      '503': 'The adapter is unavailable; a saved result can be checked later.',
    },
  }),
  method: 'POST',
  name: 'bluesky-connections.complete',
  output: mirrors<Awaited<ReturnType<ScreenshotStudioBackendSDK['completeBlueskyConnection']>>>()(
    blueskyConnectionCompleteResponseSchema
  ),
  path: '/api/v1/bluesky-connection-attempts/connect',
  status: 200,
  summary: 'Complete or recover a Bluesky connection',
})

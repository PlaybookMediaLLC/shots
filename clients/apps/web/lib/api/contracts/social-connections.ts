import {
  socialOAuthBeginRequestSchema,
  socialOAuthBeginResponseSchema,
  socialOAuthOperationSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { memberDocs } from '@/lib/api/contracts/workspace-docs'

/** Start one session-bound authorization; completing it is a separate provider callback. */
export const createSocialConnectionAttemptContract = defineContract({
  access: {
    permission: 'workspace:update',
    feature: 'content:drafts',
    quota: 'api:write:minute',
    sensitive: 'connection',
  },
  body: socialOAuthBeginRequestSchema
    .safeExtend({ operation: socialOAuthOperationSchema })
    .refine((input) => input.operation === 'CREATE_SET' || !!input.socialSetId, {
      message: 'Choose the social set this account belongs to.',
      path: ['socialSetId'],
    }),
  docs: memberDocs({
    bodyName: 'SocialConnectionAttemptRequest',
    description:
      'Starts a provider authorization for the signed-in owner or admin in the active workspace. CREATE_SET requires PRIVATE or WORKSPACE visibility; no set exists until the verified first account commits. ADD_ACCOUNT targets an existing social set, and RECONNECT also binds the existing connection. The attempt retains its original user, session, workspace, and target across workspace switches. Each call starts a new authorization; do not automatically retry a lost begin response. Provider callbacks recover their persisted result instead of exchanging the code twice. API keys cannot connect accounts.',
    operationId: 'createSocialConnectionAttempt',
    outputName: 'SocialConnectionAttemptResponse',
    responses: {
      '201': 'Authorization URL, with a persisted session-bound attempt.',
      '400': 'The operation and owner or target are inconsistent.',
      '404': 'The target does not exist or is private to another person.',
      '409': 'The account, provider slot, or subscription cannot accept this connection.',
      '429': 'The workspace write quota is exhausted.',
      '503': 'The provider or a required connection service is unavailable.',
    },
    tag: 'Publishing',
  }),
  method: 'POST',
  name: 'social-connections.start',
  output: socialOAuthBeginResponseSchema,
  path: '/api/v1/social-connection-attempts',
  status: 201,
  summary: 'Start a social account connection',
})

import {
  cancelAccountDeletionContract,
  getAccountDeletionContract,
  requestAccountDeletionContract,
} from '@/lib/api/contracts/settings-platform'
import { route } from '@/lib/api/route'
import { sessionAccess, sensitiveSessionAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Your account deletion request, if any, and what blocks one. */
export const GET = route(getAccountDeletionContract, {
  auth: sessionAccess,
  handler: ({ access }) => backendSDK({ ...access, organizationId: '' }).getAccountDeletion(),
})

/** Request deletion of your account: a fresh sign-in with two-factor authentication is required. */
export const POST = route(requestAccountDeletionContract, {
  auth: sensitiveSessionAccess,
  handler: ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).requestAccountDeletion(body.confirmation),
})

/** Withdraw your account deletion request. */
export const DELETE = route(cancelAccountDeletionContract, {
  auth: sessionAccess,
  handler: ({ access }) => backendSDK({ ...access, organizationId: '' }).cancelAccountDeletion(),
})

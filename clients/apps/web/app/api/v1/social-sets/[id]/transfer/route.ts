import {
  previewSocialSetTransferContract,
  transferSocialSetContract,
} from '@/lib/api/contracts/social-set-transfer'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

const unavailable = () => errorResponse(404, 'Social sets are not available.')

/** Where this set can move and what moving it changes. Changes nothing. */
export const GET = route(previewSocialSetTransferContract, {
  auth: organizationAccess('connection:manage'),
  handler: ({ access, params }) =>
    contentDraftsEnabled() ? backendSDK(access).previewSocialSetTransfer(params.id) : unavailable(),
})

/** Moves this set to another workspace the person owns or administers. */
export const POST = route(transferSocialSetContract, {
  auth: organizationAccess('connection:manage'),
  handler: ({ access, body, params }) =>
    contentDraftsEnabled() ? backendSDK(access).transferSocialSet(params.id, body) : unavailable(),
})

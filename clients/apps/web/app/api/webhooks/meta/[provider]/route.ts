import { metaDataCallbackContract, metaSignedRequest } from '@/lib/api/contracts/webhooks'
import { errorResponse, route } from '@/lib/api/route'
import { publicAccess } from '@/lib/api/route-auth'
import { serviceBackend } from '@/lib/backend/sdk'

/** Public because Meta calls it; the backend verifies the signature with the app secret. */
export const POST = route(metaDataCallbackContract, {
  auth: publicAccess,
  handler: async ({ body, params }) => {
    const signedRequest = metaSignedRequest(body)
    if (!signedRequest) return errorResponse(400, 'Missing signed_request.')
    return serviceBackend().metaDataCallback(params.provider, signedRequest)
  },
})

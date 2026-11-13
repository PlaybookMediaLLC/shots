import { importSenjaVideoContract, listSenjaVideosContract } from '@/lib/api/contracts/senja'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { listSenjaVideos, SenjaError, senjaKey, senjaVideoFile } from '@/lib/content-drafts/senja'
import { linkPreviewLimit } from '@/lib/link-preview/limit'
import { storeFetchedAsset } from '@/lib/tenant/assets'

const NOT_SET_UP =
  'Senja is not set up for this workspace. An admin can add its API key in Settings, under Integrations.'

/** A refused key is the caller's to fix (422); an unreachable Senja is not (503). */
function senjaFailure(error: unknown) {
  if (error instanceof SenjaError)
    return errorResponse(error.status === 401 ? 422 : error.status, error.message)
  throw error
}

/** The newest approved video testimonials of the workspace's Senja project. */
export const GET = route(listSenjaVideosContract, {
  auth: organizationAccess('artifact:read'),
  handler: async ({ access }) => {
    if (!contentDraftsEnabled()) return errorResponse(503, 'Drafts are not enabled.')
    const key = await senjaKey(access)
    if (!key) return errorResponse(409, NOT_SET_UP)
    try {
      return { items: await listSenjaVideos(key) }
    } catch (error) {
      return senjaFailure(error)
    }
  },
})

/** Store a testimonial's video through the same signed-upload and Go completion checks as a file upload. */
export const POST = route(importSenjaVideoContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body }) => {
    if (!contentDraftsEnabled()) return errorResponse(503, 'Drafts are not enabled.')
    const key = await senjaKey(access)
    if (!key) return errorResponse(409, NOT_SET_UP)
    const limited = await linkPreviewLimit(access.organizationId)
    if (limited) return limited
    try {
      const asset = await storeFetchedAsset(access, await senjaVideoFile(key, body.id))
      if (!asset) return errorResponse(503, 'The video could not be saved. Try again.')
      return { assetId: asset.id, mediaType: 'video/mp4' as const }
    } catch (error) {
      return senjaFailure(error)
    }
  },
})

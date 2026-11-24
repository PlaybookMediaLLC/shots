import { kitExportContentContract } from '@/lib/api/contracts/internal'
import { route } from '@/lib/api/route'
import { serviceBackend } from '@/lib/backend/sdk'

/** Go authenticates the opaque grant and rechecks live dependencies before returning bytes. */
export const GET = route(kitExportContentContract, {
  auth: async () => null,
  handler: async ({ params, query }) => {
    const source = await serviceBackend().readKitExportDownload(
      params.id,
      params.exportId,
      query.downloadToken
    )
    return new Response(source.body, {
      status: source.status,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="release-kit.zip"',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
      },
    })
  },
})

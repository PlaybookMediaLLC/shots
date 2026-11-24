import { z } from 'zod'
import { kitRenderContract } from '@/lib/api/contracts/internal'
import { route } from '@/lib/api/route'
import { AuthorizationError } from '@/lib/auth/access'
import { verifyWorkflowRenderSignature } from '@/lib/workflows/render-signature'
import { kitRenderRequestSchema } from '@/lib/releases/kit-render-schema'
import { renderKitSnapshot } from '@/lib/releases/kit-render'

/** Render a frozen worker request after verifying the signature of its exact bytes. */
export const POST = route(kitRenderContract, {
  auth: async ({ raw, request }) => {
    const { body } = await raw()
    if (
      !verifyWorkflowRenderSignature(
        z.string().parse(body),
        request.headers.get('x-shots-signature'),
        process.env.PLATFORM_WORKFLOW_RENDER_KEY ?? ''
      )
    )
      throw new AuthorizationError('Unauthorized kit render.', 401)
    return null
  },
  handler: async ({ body }) => renderKitSnapshot(kitRenderRequestSchema.parse(JSON.parse(body))),
})

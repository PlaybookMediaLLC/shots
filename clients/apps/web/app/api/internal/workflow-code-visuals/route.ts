import { z } from 'zod'
import { workflowCodeVisualContract } from '@/lib/api/contracts/internal'
import { apiError } from '@/lib/api/errors'
import { type Authenticate, route } from '@/lib/api/route'
import { AuthorizationError } from '@/lib/auth/access'
import { CodeRendererUnavailableError } from '@/lib/code-studio/render'
import { DesignRenderLimitError } from '@/lib/design/render-design'
import {
  renderWorkflowCodeVisual,
  workflowCodeVisualRequestSchema,
} from '@/lib/workflows/code-visual'
import { WorkflowRenderUnavailableError } from '@/lib/workflows/render'
import { verifyWorkflowRenderSignature } from '@/lib/workflows/render-signature'

/** The Go worker signs the exact body with the shared workflow render key. */
const workerSignatureAccess: Authenticate<null> = async ({ raw, request }) => {
  const { body } = await raw()
  if (
    !verifyWorkflowRenderSignature(
      z.string().parse(body),
      request.headers.get('x-shots-signature'),
      process.env.PLATFORM_WORKFLOW_RENDER_KEY ?? ''
    )
  ) {
    throw new AuthorizationError('Unauthorized workflow render.', 401)
  }
  return null
}

/**
 * Render a merged pull request as a code visual into a workflow run's
 * campaign. The tenant comes from the signed request the worker built from
 * its persisted run; a retry reuses the project and image.
 */
export const POST = route(workflowCodeVisualContract, {
  auth: workerSignatureAccess,
  handler: async ({ body }) => {
    const request = workflowCodeVisualRequestSchema.safeParse(JSON.parse(body))
    if (!request.success) {
      return apiError(
        422,
        'invalid_request',
        z.prettifyError(request.error),
        'Fix the worker request.'
      )
    }
    try {
      return await renderWorkflowCodeVisual(request.data)
    } catch (error) {
      if (
        error instanceof WorkflowRenderUnavailableError ||
        error instanceof CodeRendererUnavailableError ||
        error instanceof DesignRenderLimitError
      ) {
        return apiError(
          503,
          'upstream_unavailable',
          error.message,
          'Retry after the renderer recovers.'
        )
      }
      if (error instanceof z.ZodError) {
        return apiError(422, 'invalid_request', z.prettifyError(error), 'Fix the worker request.')
      }
      throw error
    }
  },
})

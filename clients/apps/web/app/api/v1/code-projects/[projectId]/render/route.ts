import { renderCodeProjectContract } from '@/lib/api/contracts/code-projects'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { CodeRendererUnavailableError, renderCodeProject } from '@/lib/code-studio/render'
import { DesignRenderLimitError } from '@/lib/design/render-design'
import { getCodeProject } from '@/lib/tenant/code-projects'

/** Render one slide of a code project as a stored PNG. */
export const POST = route(renderCodeProjectContract, {
  auth: tenantAccess(renderCodeProjectContract.access),
  handler: async ({ access, body, params }) => {
    const project = await getCodeProject(access, params.projectId)
    if (!project) return errorResponse(404, 'Code project not found.')
    if (body.slide >= project.document.slides.length)
      return errorResponse(400, `The project has ${project.document.slides.length} slides.`)
    try {
      const rendered = await renderCodeProject(access, params.projectId, body)
      return { ...rendered, mediaType: 'image/png' as const }
    } catch (error) {
      if (error instanceof CodeRendererUnavailableError) return errorResponse(503, error.message)
      if (error instanceof DesignRenderLimitError) return errorResponse(429, error.message)
      throw error
    }
  },
})

import 'server-only'

import type { TenantContext } from '@/lib/auth/access'
import { enforceRenderLimit } from '@/lib/design/render-design'
import { createDesignRenderer, isDesignRendererAvailable } from '@/lib/design/renderer'
import { storeGeneratedAsset } from '@/lib/tenant/assets'

/** The headless renderer is not configured for this deployment. */
export class CodeRendererUnavailableError extends Error {
  constructor() {
    super('Server-side rendering is not available. Export from Code Studio in the browser instead.')
    this.name = 'CodeRendererUnavailableError'
  }
}

/**
 * Render one slide of a code project on the server and keep it as a
 * workspace export (RFC 053), for the public API and Automate. It counts
 * against the workspace's render limit like any design render.
 */
export async function renderCodeProject(
  tenant: TenantContext,
  projectId: string,
  options: { slide: number; scale: 1 | 2 | 3 }
) {
  if (!isDesignRendererAvailable()) throw new CodeRendererUnavailableError()
  await enforceRenderLimit(tenant.organizationId)
  const renderer = await createDesignRenderer()
  try {
    const rendered = await renderer.renderCode(projectId, tenant.organizationId, options)
    const asset = await storeGeneratedAsset(tenant, {
      body: rendered.bytes,
      classification: 'export',
      contentType: rendered.mediaType,
      fileName: 'code.png',
      height: rendered.height,
      width: rendered.width,
    })
    return {
      assetId: asset.id,
      height: rendered.height,
      mediaType: rendered.mediaType,
      width: rendered.width,
    }
  } finally {
    await renderer.close()
  }
}

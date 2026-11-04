import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CodeRender } from '@/components/code-studio/CodeRender'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { verifyRenderToken } from '@/lib/design/render-token'
import { readTenantObject } from '@/lib/storage/client'
import { getCodeProject } from '@/lib/tenant/code-projects'

export const metadata: Metadata = { robots: { follow: false, index: false } }

type CodeRenderPageProps = {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ token?: string; slide?: string; scale?: string }>
}

/**
 * Chrome-free page for the headless renderer: one slide of one code project
 * (RFC 053). Only a render token for this project opens it; the footer logo
 * is inlined so the render needs no session.
 */
export default async function CodeRenderPage({ params, searchParams }: CodeRenderPageProps) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  const claims = verifyRenderToken(query.token, `code:${projectId}`)
  if (!claims) notFound()
  const tenant: TenantContext = {
    organizationId: claims.organizationId,
    principal: {
      kind: 'trigger_service',
      organizationId: claims.organizationId,
      taskRunId: `code-render:${projectId}`,
    },
    requestId: `code-render:${projectId}`,
  }
  const project = await getCodeProject(tenant, projectId)
  if (!project) notFound()
  const slide = Math.min(Math.max(Number(query.slide) || 0, 0), project.document.slides.length - 1)
  const scale = [1, 2, 3].includes(Number(query.scale)) ? Number(query.scale) : 2
  let logoUrl: string | undefined
  const logo = project.document.style.footer.logo?.slice('asset:'.length)
  if (logo) {
    const { assets } = await backendSDK(tenant).findAssets({ ids: [logo] })
    const asset = assets.find((item) => item.status === 'UPLOADED')
    if (asset) {
      const bytes = await readTenantObject({ assetId: asset.id, tenant })
      logoUrl = `data:${asset.mediaType};base64,${Buffer.from(bytes).toString('base64')}`
    }
  }
  return <CodeRender document={project.document} slide={slide} scale={scale} logoUrl={logoUrl} />
}

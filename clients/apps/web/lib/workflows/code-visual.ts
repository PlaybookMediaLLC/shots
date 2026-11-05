import 'server-only'

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { codeDocumentSchema, codeStyleSchema, CODE_FILE_LIMIT } from '@/lib/code-studio/document'
import { importedSlides } from '@/lib/code-studio/import'
import { renderCodeProject } from '@/lib/code-studio/render'
import { isDesignRendererReady } from '@/lib/design/renderer'
import { getCampaign } from '@/lib/tenant/campaigns'
import { createCodeProject, getCodeProject } from '@/lib/tenant/code-projects'
import { WorkflowRenderUnavailableError } from './render'

/** A worker's request to render a merged pull request as a code visual; the Go action builds it. */
export const workflowCodeVisualRequestSchema = z.strictObject({
  organizationId: z.string().min(1).max(128),
  campaignId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().max(200),
  url: z.string().max(2_000),
  repo: z.string().max(200),
  files: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(1_000),
        patch: z.string().min(1).max(CODE_FILE_LIMIT),
        status: z.string().max(40).optional(),
        code: z.string().max(CODE_FILE_LIMIT).optional(),
      })
    )
    .min(1)
    .max(3),
})

/** A workflow code visual request. */
export type WorkflowCodeVisualRequest = z.infer<typeof workflowCodeVisualRequestSchema>

/** The run and node's code project id, so a retried request finds what it made. */
export function workflowCodeProjectId(runId: string, nodeId: string): string {
  return `c${createHash('sha256').update(`${runId}:${nodeId}`).digest('hex').slice(0, 24)}`
}

/**
 * Turn a merged pull request's changes into a Code Studio project (one diff
 * slide per file), render its first slide and attach the image to the run's
 * campaign as a `code-visual` for review. A retry reuses the project and the
 * image this node already attached.
 */
export async function renderWorkflowCodeVisual(request: WorkflowCodeVisualRequest) {
  if (!(await isDesignRendererReady())) throw new WorkflowRenderUnavailableError()
  const tenant: TenantContext = {
    organizationId: request.organizationId,
    principal: {
      kind: 'trigger_service',
      organizationId: request.organizationId,
      taskRunId: `workflow:${request.runId}:${request.nodeId}`,
    },
    requestId: `${request.runId}:${request.nodeId}`,
  }
  const campaign = await getCampaign(tenant, request.campaignId)
  if (!campaign)
    throw new z.ZodError([{ code: 'custom', message: 'Unknown campaign.', path: ['campaignId'] }])
  const projectId = workflowCodeProjectId(request.runId, request.nodeId)
  const name = (request.title || request.repo || 'Code change').slice(0, 200)
  if (!(await getCodeProject(tenant, projectId))) {
    const slides = importedSlides(
      { kind: 'github-pull', url: request.url, repo: request.repo, files: request.files },
      'diff'
    )
    await createCodeProject(tenant, {
      id: projectId,
      name,
      document: codeDocumentSchema.parse({
        version: 1,
        kind: 'code',
        style: codeStyleSchema.parse({ aspect: '16:9' }),
        slides,
        source: {
          kind: 'github-pull',
          url: request.url || undefined,
          repo: request.repo || undefined,
        },
      }),
    })
  }
  const caption = `${name} · code visual`
  const attached = campaign.assets.find(
    (link) => link.kind === 'code-visual' && link.caption === caption
  )
  if (attached) return { assetId: attached.assetId, projectId }
  const rendered = await renderCodeProject(tenant, projectId, { slide: 0, scale: 2 })
  await backendSDK(tenant).linkCampaignAsset(request.campaignId, rendered.assetId, {
    caption,
    kind: 'code-visual',
  })
  return { assetId: rendered.assetId, projectId }
}

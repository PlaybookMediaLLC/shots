import 'server-only'

import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { BRAND_LOGO_ID } from '@/lib/brand/apply'
import { type DesignDocument, patchDesignDocument } from '@/lib/design/document'
import { renderDesignForTenant } from '@/lib/design/render-design'
import {
  createDesignRenderer,
  type DesignRenderer,
  isDesignRendererReady,
} from '@/lib/design/renderer'
import { getDesignTemplate } from '@/lib/design/templates'
import { documentCanvasSize, screenshotBox } from '@/lib/export/adapt'
import { brandDesignChanges, parseBrandKit } from '@/lib/launch/brand'
import { createDesign, getDesign, listCampaignDesigns } from '@/lib/tenant/designs'

/** A worker's request to render a campaign's creatives; the Go action builds it. */
export const workflowRenderRequestSchema = z.strictObject({
  organizationId: z.string().min(1).max(128),
  campaignId: z.string().min(1).max(64),
  runId: z.string().min(1).max(64),
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  brandKitId: z.string().max(64).optional(),
  captureAssetId: z.string().min(1).max(64),
  headline: z.string().max(60),
  subheadline: z.string().max(100).optional(),
  templateIds: z
    .array(z.string().regex(/^[a-z0-9-]{1,64}$/))
    .min(1)
    .max(3),
  /** Which of the node's captures this is; part 0 keeps the node's original design names. */
  part: z.number().int().min(0).max(2).optional(),
  /** Normalized bounding box (0-1 viewport fractions) of the captured marker element. */
  focus: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0).max(1),
      h: z.number().min(0).max(1),
    })
    .optional(),
})

/** One rendered creative, linked to the campaign as a design render. */
export const workflowRenderSchema = z.strictObject({
  templateId: z.string(),
  designId: z.string(),
  assetId: z.string(),
})

/** A workflow render request. */
export type WorkflowRenderRequest = z.infer<typeof workflowRenderRequestSchema>

/** The renderer is off or unreachable; the worker retries later. */
export class WorkflowRenderUnavailableError extends Error {
  constructor() {
    super('The design renderer is not available.')
    this.name = 'WorkflowRenderUnavailableError'
  }
}

/**
 * Maps a normalized viewport marker box (`0..1` of the screenshot) into canvas
 * coordinates using the stage's own screenshot geometry. Skips device mockups
 * and 3D-tilted screenshots where a flat canvas rectangle would misalign.
 */
export function buildFocusAnnotation(
  document: DesignDocument,
  focus: NonNullable<WorkflowRenderRequest['focus']>,
  imageAspect: number | undefined,
  strokeColor: string
): DesignDocument['annotations'][number] | null {
  const area = focus.w * focus.h
  if (area <= 0.002 || area >= 0.72) return null
  if (document.mode === 'device') return null
  const perspective = document.image.perspective
  if (
    perspective &&
    ((perspective.rotateX ?? 0) !== 0 ||
      (perspective.rotateY ?? 0) !== 0 ||
      (perspective.rotateZ ?? 0) !== 0)
  ) {
    return null
  }
  const box = screenshotBox(document, documentCanvasSize(document), imageAspect)
  if (!box) return null
  const left = box.cx - box.width / 2
  const top = box.cy - box.height / 2
  const clamp = (v: number) => Math.max(0.02, Math.min(0.98, v))
  const sx = clamp(left + focus.x * box.width)
  const sy = clamp(top + focus.y * box.height)
  const ex = clamp(left + (focus.x + focus.w) * box.width)
  const ey = clamp(top + (focus.y + focus.h) * box.height)
  if (ex <= sx + 0.02 || ey <= sy + 0.02) return null
  return {
    id: 'capture-focus-box',
    type: 'rectangle',
    start: { x: sx, y: sy },
    end: { x: ex, y: ey },
    strokeColor,
    strokeWidth: 4,
    fillColor: 'transparent',
    opacity: 0.9,
    radius: 0.04,
  }
}

/**
 * Fill each template with the product capture and the event's headline,
 * style it with the campaign's brand kit, render it, and link the image to
 * the campaign. A design this node already made is reused, and identical
 * renders hit the render cache, so a retried request duplicates nothing.
 * The designs stay drafts: a person approves them before scheduling.
 */
export async function renderWorkflowCreatives(request: WorkflowRenderRequest) {
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
  const templates = request.templateIds.map((id) => {
    const template = getDesignTemplate(id)
    if (!template)
      throw new z.ZodError([
        { code: 'custom', message: `Unknown template ${id}.`, path: ['templateIds'] },
      ])
    return template
  })
  const [brandKitResult, captureAssetResult, existing] = await Promise.all([
    request.brandKitId ? backendSDK(tenant).listBrandKits() : Promise.resolve({ brandKits: [] }),
    request.focus
      ? backendSDK(tenant)
          .findAssets({ ids: [request.captureAssetId] })
          .catch(() => ({ assets: [] }))
      : Promise.resolve({ assets: [] }),
    listCampaignDesigns(tenant, request.campaignId),
  ])
  const { brandKits } = brandKitResult
  const captureAsset = captureAssetResult.assets.find((item) => item.id === request.captureAssetId)
  const captureAspect =
    captureAsset?.width && captureAsset?.height
      ? captureAsset.width / captureAsset.height
      : undefined
  const kitRow = brandKits.find((kit) => kit.id === request.brandKitId)
  const kit = kitRow ? parseBrandKit(kitRow.name, kitRow.definition) : null
  const lazy: { renderer?: Promise<DesignRenderer> } = {}
  const getRenderer = () => (lazy.renderer ??= createDesignRenderer())
  try {
    const settled = await Promise.allSettled(
      templates.map(async (template) => {
        const name = `Workflow ${request.nodeId} · ${template.id}${request.part ? ` · ${request.part + 1}` : ''}`
        const reused = existing.find((item) => item.name === name && item.templateId === template.id)
        let design = reused ? await getDesign(tenant, reused.id) : null
        if (!design) {
          let document = template.build({
            headline: request.headline,
            screenshot: `asset:${request.captureAssetId}`,
            subheadline: request.subheadline,
          })
          if (kit) document = patchDesignDocument(document, brandDesignChanges(kit, document.texts))
          // The brand logo, small in the top left corner, above everything else.
          if (kit?.logoAssetId)
            document = patchDesignDocument(document, {
              overlays: [
                ...document.overlays,
                {
                  id: BRAND_LOGO_ID,
                  position: { x: 0.08, y: 0.09 },
                  size: 0.09,
                  src: `asset:${kit.logoAssetId}`,
                },
              ],
            })
          // Spotlight the changed marker region in transformed canvas coordinates.
          if (request.focus) {
            const focusAnnotation = buildFocusAnnotation(
              document,
              request.focus,
              captureAspect,
              kit?.accent ?? '#3b82f6'
            )
            if (focusAnnotation) {
              document = patchDesignDocument(document, {
                annotations: [...document.annotations, focusAnnotation],
              })
            }
          }
          design = await createDesign(tenant, {
            campaignId: request.campaignId,
            document,
            name,
            templateId: template.id,
          })
        }
        const rendered = await renderDesignForTenant(tenant, getRenderer, design)
        await backendSDK(tenant).linkCampaignAsset(request.campaignId, rendered.asset.id, {
          caption: `${request.headline} · ${template.name}`,
          kind: 'design-render',
        })
        return { assetId: rendered.asset.id, designId: design.id, templateId: template.id }
      })
    )
    const renders: z.infer<typeof workflowRenderSchema>[] = []
    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw outcome.reason
      renders.push(outcome.value)
    }
    return { renders }
  } finally {
    await lazy.renderer?.then((renderer) => renderer.close()).catch(() => undefined)
  }
}

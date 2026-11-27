import 'server-only'

import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import type { TenantContext } from '@/lib/auth/access'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { backendSDK } from '@/lib/backend/sdk'
import { type Artboard, canvasDocumentSchema } from '@/lib/canvas/document'
import { releaseCanvas, releaseEvidence } from '@/lib/canvas/plan'
import { canvasRecipeSchema, type RecipeScreenshot } from '@/lib/canvas/recipes'
import { encodeRgbPng } from '@/lib/store-screenshots/export/png'
import { readTenantObject } from '@/lib/storage/client'
import { storeGeneratedAsset } from '@/lib/tenant/assets'
import { createCanvas, getCanvas } from '@/lib/tenant/canvases'
import { renderDesignForTenant } from '@/lib/design/render-design'
import {
  createDesignRenderer,
  type DesignRenderer,
  isDesignRendererReady,
} from '@/lib/design/renderer'
import { createDesign, getDesign, listCampaignDesigns } from '@/lib/tenant/designs'

/** A worker's request to lay out a canvas from a release; the Go action builds it. */
export const workflowCanvasRequestSchema = z.strictObject({
  organizationId: z.string().min(1).max(128),
  runId: z.string().min(1).max(64),
  nodeId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  releaseId: z.string().min(1).max(64),
  campaignId: z.string().max(64).optional(),
  captureAssetId: z.string().max(64).optional(),
  /** A release-matched run's captures, laid out before the release's screenshots. */
  captureAssetIds: z.array(z.string().min(1).max(64)).max(3).optional(),
  recipeIds: z.array(canvasRecipeSchema).min(1).max(3),
})
/** One of {@link workflowCanvasRequestSchema}. */
export type WorkflowCanvasRequest = z.infer<typeof workflowCanvasRequestSchema>

/** The release has nothing to lay out; retrying cannot help. */
export class WorkflowCanvasRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowCanvasRefusedError'
  }
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

/** The canvas a run's node makes: the same id on every retry. */
export function workflowCanvasId(
  request: Pick<WorkflowCanvasRequest, 'organizationId' | 'runId' | 'nodeId'>
) {
  return `c${hash(`${request.organizationId}:${request.runId}:${request.nodeId}`).slice(0, 24)}`
}

/** Ids that repeat for the same canvas, so a retried layout is identical. */
function seededIds(seed: string) {
  let count = 0
  return () => {
    const hex = hash(`${seed}:${count++}`)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
}

/** A solid colour as RGB, from #rgb or #rrggbb; anything else is white. */
function rgbOf(color: string): [number, number, number] {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color)
  if (short)
    return [1, 2, 3].map((index) => parseInt(short[index]!.repeat(2), 16)) as [
      number,
      number,
      number,
    ]
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color)
  return long
    ? ([1, 2, 3].map((index) => parseInt(long[index]!, 16)) as [number, number, number])
    : [255, 255, 255]
}

/**
 * Lay out a canvas from a release with canvas templates and store it in the
 * workspace. Words come from the release record; screenshots are the
 * release's own, or the product capture the worker found. A canvas this
 * node already made is returned as it is.
 */
export async function createWorkflowCanvas(request: WorkflowCanvasRequest) {
  const tenant: TenantContext = {
    organizationId: request.organizationId,
    principal: {
      kind: 'trigger_service',
      organizationId: request.organizationId,
      taskRunId: `workflow:${request.runId}:${request.nodeId}`,
    },
    requestId: `${request.runId}:${request.nodeId}`,
  }
  const canvasId = workflowCanvasId(request)
  const made = await getCanvas(tenant, canvasId)
  if (made) {
    await renderCanvasIntoCampaign(tenant, request, made.document.artboards, made.name)
    return { canvasId }
  }
  // A malformed id (400) and a missing one (404) are both not a release of this workspace.
  const release = await backendSDK(tenant)
    .getRelease(request.releaseId)
    .catch((error: unknown) => {
      if (error instanceof BackendSDKError && (error.status === 400 || error.status === 404))
        return null
      throw error
    })
  if (!release) throw new WorkflowCanvasRefusedError('The release is not in this workspace.')
  // A release-matched run's captures show this release; otherwise the release's
  // screenshots come first, then the run's or the latest capture.
  const ids = request.captureAssetIds?.length
    ? [...request.captureAssetIds]
    : [...(release.screenshotAssetIds ?? []).slice(0, 2)]
  if (!ids.length && request.captureAssetId) ids.push(request.captureAssetId)
  const { assets } = ids.length ? await backendSDK(tenant).findAssets({ ids }) : { assets: [] }
  const screenshots: RecipeScreenshot[] = []
  for (const [index, id] of ids.entries()) {
    const asset = assets.find((item) => item.id === id)
    if (asset?.status !== 'UPLOADED') continue
    // Uploads do not record their size; read it from the image itself.
    const size =
      asset.width && asset.height
        ? { width: asset.width, height: asset.height }
        : await sharp(await readTenantObject({ assetId: id, tenant }))
            .metadata()
            .then((meta) => ({ width: meta.width ?? 0, height: meta.height ?? 0 }))
    if (!size.width || !size.height) continue
    screenshots.push({
      src: `asset:${id}`,
      name: `${release.title.slice(0, 160)} ${index + 1}`,
      ...size,
    })
  }
  const input = { release: releaseEvidence(release), screenshots }

  // Filled containers are images. Find the fills the layout needs, store each
  // one as a workspace asset, then lay it out again with those assets.
  const needed = new Map<string, { color: string; width: number; height: number }>()
  const key = (color: string, aspect: number) => {
    const height = Math.max(1, Math.round(240 / Math.max(0.05, aspect)))
    return { id: `${color}:${height}`, width: 240, height }
  }
  releaseCanvas(request.recipeIds, input, {
    newId: seededIds(canvasId),
    fill: (color, aspect) => {
      const size = key(color, aspect)
      needed.set(size.id, { color, width: size.width, height: size.height })
      return 'asset:00000000-0000-4000-8000-000000000000'
    },
  })
  const stored = new Map<string, string>()
  for (const [id, fill] of needed) {
    const [r, g, b] = rgbOf(fill.color)
    const pixels = new Uint8Array(fill.width * fill.height * 4)
    for (let at = 0; at < pixels.length; at += 4) pixels.set([r, g, b, 255], at)
    const asset = await storeGeneratedAsset(tenant, {
      body: await encodeRgbPng(pixels, fill.width, fill.height),
      classification: 'derived',
      contentType: 'image/png',
      fileName: 'canvas-fill.png',
      height: fill.height,
      width: fill.width,
    })
    stored.set(id, `asset:${asset.id}`)
  }
  const artboards = releaseCanvas(request.recipeIds, input, {
    newId: seededIds(canvasId),
    fill: (color, aspect) => stored.get(key(color, aspect).id)!,
  })
  const document = canvasDocumentSchema.parse({
    version: 1,
    kind: 'canvas',
    artboards,
    context: {
      releaseId: release.id,
      ...(request.campaignId ? { campaignId: request.campaignId } : {}),
    },
  })
  const name = `${release.title.slice(0, 160)} · canvas`
  try {
    await createCanvas(tenant, { id: canvasId, name, document })
  } catch (error) {
    // A concurrent attempt stored it first; that canvas is the result.
    if (!(await getCanvas(tenant, canvasId))) throw error
  }
  await renderCanvasIntoCampaign(tenant, request, document.artboards, name)
  return { canvasId }
}

/** Artboards one canvas renders into its campaign, within the worker's request timeout. */
const MAX_CANVAS_RENDERS = 3

/**
 * Render a release-matched run's canvas artboards into its campaign as
 * designs, so reviewers see them beside the other creatives; the canvas itself
 * stays editable. Other runs, and any run without a campaign or a running
 * renderer, keep the canvas as their whole result, as before. A retry reuses
 * this node's designs and the render cache.
 */
async function renderCanvasIntoCampaign(
  tenant: TenantContext,
  request: WorkflowCanvasRequest,
  artboards: readonly Artboard[],
  title: string
) {
  if (!request.campaignId || !request.captureAssetIds?.length || !(await isDesignRendererReady()))
    return
  const campaignId = request.campaignId
  const existing = await listCampaignDesigns(tenant, campaignId)
  const lazy: { renderer?: Promise<DesignRenderer> } = {}
  const getRenderer = () => (lazy.renderer ??= createDesignRenderer())
  try {
    const settled = await Promise.allSettled(
      artboards.slice(0, MAX_CANVAS_RENDERS).map(async (artboard, index) => {
        const name = `Workflow ${request.nodeId} · canvas ${index + 1}`
        const reused = existing.find((item) => item.name === name)
        const design =
          (reused ? await getDesign(tenant, reused.id) : null) ??
          (await createDesign(tenant, {
            campaignId,
            document: artboard.document,
            name,
          }))
        const rendered = await renderDesignForTenant(tenant, getRenderer, design)
        await backendSDK(tenant).linkCampaignAsset(campaignId, rendered.asset.id, {
          caption: `${title} · ${index + 1}`,
          kind: 'design-render',
        })
      })
    )
    for (const outcome of settled) {
      if (outcome.status === 'rejected') throw outcome.reason
    }
  } finally {
    await lazy.renderer?.then((renderer) => renderer.close()).catch(() => undefined)
  }
}

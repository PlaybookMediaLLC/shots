'use client'

import { useExportProgress } from '@/hooks/useExportProgress'
import { canonicalJson } from '@/lib/design/canonical-json'
import { exportDesignDocument } from '@/lib/design/export'
import { exportStill, type StillFormat, stillFormatSchema } from '@/lib/export/export-design'
import { frameRateFor } from '@/lib/export/export-settings'
import { formatHasControl, type OutputFormat, type QualityPresetName } from '@/lib/export/formats'
import { canvasTarget } from '@/lib/export/sizes'
import { exportAnimationVideo, exportSlideshowVideo } from '@/lib/export-slideshow-video'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { contentHash } from '@/lib/write/versions'
import {
  buildExportFileName,
  saveExportToWorkspace,
  type SaveToWorkspaceInput,
} from '@/lib/workspace/save-export'

/**
 * The editor's half of publishing: a design becomes the exact files a social
 * post carries.
 *
 * `Editor state → rendered files → workspace assets → draft media nodes`,
 * after which the composer owns the post: the editor opens it in the
 * publishing workspace and hands these nodes to the composer's own editor.
 * Nothing here knows about destinations, captions or scheduling.
 *
 * Every file comes from the editor's own export pipelines — `exportStill` for
 * stills and slides, the slideshow and animation encoders for video and GIF —
 * so what publishes is what Export downloads.
 */

/** Still formats a connected destination can be sent, in the media rules' terms. */
const PUBLISHABLE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'webp'])

/**
 * The format a publication export uses.
 *
 * A raster format the destinations understand is kept, so someone who chose
 * JPEG for its size publishes JPEG. SVG, PDF and the animated formats are not
 * still images a post can carry, so those publish as PNG. The chosen format is
 * never written back to the saved export preferences: this is one export, not
 * a settings change.
 */
export function publishableFormat(format: OutputFormat): StillFormat {
  return PUBLISHABLE_FORMATS.has(format) ? stillFormatSchema.parse(format) : 'png'
}

/** How a publication export is produced; two renders of one revision match. */
export type PublishExportConfig = {
  format: StillFormat
  quality: QualityPresetName
  scale: number
  transparent: boolean
}

/** A rendered file, with the revision of the design it was taken from. */
export type PublicationRender = {
  blob: Blob
  mimeType: string
  /** The design and settings these bytes came from; see {@link compositionRevision}. */
  revision: string
}

/**
 * What the editor can publish: the canvas as one image, every slide as one
 * image each (a carousel, in slide order), or the design playing as a video
 * or a GIF.
 */
export type PublishKind = 'image' | 'slides' | 'video' | 'gif'

/** Each kind as the Publish menu names it. */
export function publishKindLabel(kind: PublishKind, slideCount: number): string {
  return kind === 'image'
    ? 'Image'
    : kind === 'slides'
      ? `All ${slideCount} slides`
      : kind === 'video'
        ? 'Video (MP4)'
        : 'GIF'
}

/**
 * The kinds this design offers, the canvas image first. Slides are offered
 * only with two or more, and video and GIF only when the design plays over
 * time (`canExportMotion`), as Export offers them.
 */
export function publishKinds(design: { canAnimate: boolean; slideCount: number }): PublishKind[] {
  return [
    'image',
    ...(design.slideCount > 1 ? (['slides'] as const) : []),
    ...(design.canAnimate ? (['video', 'gif'] as const) : []),
  ]
}

/**
 * A stable name for one composition exported one way.
 *
 * The design document is what the renderer draws, so hashing it keys the
 * render by content rather than by a store reference that mutates in place.
 * The length joins the hash because `contentHash` is a 32-bit FNV: together
 * they are enough to tell one edit of a design from another within a session,
 * and a collision would reuse a render, never publish a different design.
 */
export function compositionRevision(document: unknown, config: object): string {
  const json = canonicalJson({ config, document })
  return `${contentHash(json)}-${json.length}`
}

/** The export config for a publication, from the editor's current export settings. */
export function publishExportConfig(settings: {
  format: OutputFormat
  quality: QualityPresetName
  scale: number
  transparent: boolean
}): PublishExportConfig {
  const format = publishableFormat(settings.format)
  return {
    format,
    quality: settings.quality,
    scale: settings.scale,
    // Transparency survives only into a format that has it; JPEG would
    // otherwise silently flatten it against an unrelated colour.
    transparent: settings.transparent && formatHasControl(format, 'transparency'),
  }
}

/** What a publication render needs from the editor: its canvas, name and export settings. */
export type PublishRenderInput = {
  canvas: { height: number; width: number }
  /** The export panel's settings; read, never written. */
  settings: {
    format: OutputFormat
    fps: number
    gifWidth: number
    quality: QualityPresetName
    scale: number
    transparent: boolean
  }
  /** Whether the design has a timeline (animation export) rather than only slides. */
  hasTimeline: boolean
  /** Base file name, usually the screenshot's name. */
  name: string
  /** Render progress, 0 to 100. */
  onProgress?: (progress: number) => void
}

/**
 * Render the design as the files a post of this kind carries.
 *
 * Each revision is read before its file is made, so the bytes are labelled
 * with the design they were taken from even if the editor changes while the
 * export runs.
 */
export async function renderPublications(
  kind: PublishKind,
  input: PublishRenderInput
): Promise<PublicationRender[]> {
  const document = exportDesignDocument({ keepLocalSources: true })
  if (kind === 'video' || kind === 'gif') {
    const format = kind === 'gif' ? 'gif' : 'mp4'
    const options = {
      format,
      fps: frameRateFor(format, input.settings.fps),
      maxWidth: format === 'gif' && input.settings.gifWidth > 0 ? input.settings.gifWidth : undefined,
      quality: input.settings.quality,
    } as const
    const revision = compositionRevision(document, { ...options, kind })
    let file: Blob | undefined
    // The encoders report into the export progress store the Export panel reads.
    const unsubscribe = useExportProgress.subscribe((state) =>
      input.onProgress?.(Math.round(state.progress))
    )
    try {
      const run = input.hasTimeline ? exportAnimationVideo : exportSlideshowVideo
      await run({ ...options, onFile: (blob) => (file = blob) })
    } finally {
      unsubscribe()
    }
    if (!file || file.size === 0) throw new Error(`The design produced no ${kind} to publish.`)
    // Storage and the media rules key on the type; an encoder that leaves it
    // off still made the format that was asked for.
    const mimeType = file.type || (format === 'gif' ? 'image/gif' : 'video/mp4')
    const blob = file.type ? file : new Blob([file], { type: mimeType })
    return [{ blob, mimeType, revision }]
  }
  const config = publishExportConfig(input.settings)
  const files = await exportStill({
    allSlides: kind === 'slides',
    format: config.format,
    name: input.name,
    onProgress: (done, total) => input.onProgress?.(Math.round((done / total) * 100)),
    // A still publication never produces a PDF, so the setting cannot apply.
    pdfCompression: 'jpeg',
    quality: config.quality,
    scale: config.scale,
    targets: [canvasTarget(input.canvas.width, input.canvas.height)],
    transparent: config.transparent,
  })
  if (files.length === 0 || files.some((file) => file.blob.size === 0))
    throw new Error('The design produced no image to publish.')
  return files.map((file, index) => ({
    blob: file.blob,
    mimeType: file.blob.type,
    // Each slide is its own file: the same design, a different picture.
    revision: compositionRevision(document, { ...config, kind, slide: index }),
  }))
}

/** A render saved as a workspace asset, with the revision it was made from. */
export type PublicationAsset = { assetId: string; revision: string }

/** How many stored renders this browser remembers: a carousel's worth and then some. */
const REMEMBERED_LIMIT = 32

/**
 * The publication assets this browser stored, by workspace and revision.
 *
 * Publishing the same unchanged design again (another post, the same
 * carousel, a retry after closing the workspace) attaches the assets that
 * already hold those pixels instead of storing them again under new ids and
 * leaving the first ones orphaned. Any edit changes the revision and stores
 * new assets, as it should. `scope` is the workspace, so an asset is never
 * offered to a workspace that cannot read it.
 */
const remembered = new Map<string, PublicationAsset>()

/** The stored asset for this exact design and export, if this browser still has one. */
export function rememberedPublication(
  scope: string,
  revision: string
): PublicationAsset | undefined {
  return remembered.get(`${scope}\n${revision}`)
}

/** Remember a stored asset for {@link rememberedPublication}, dropping the oldest past the limit. */
export function rememberPublication(scope: string, asset: PublicationAsset): void {
  const key = `${scope}\n${asset.revision}`
  remembered.delete(key)
  remembered.set(key, asset)
  while (remembered.size > REMEMBERED_LIMIT) remembered.delete(remembered.keys().next().value!)
}

/**
 * Save a render as a workspace asset the draft can reference.
 *
 * `reuse` is the asset the same revision already produced: repeated clicks on
 * an unchanged composition attach the asset that exists instead of storing the
 * same pixels again under a new id.
 */
export async function uploadPublication(input: {
  onProgress?: (progress: number) => void
  projectId?: string
  render: PublicationRender
  reuse?: PublicationAsset
  trpcClient: SaveToWorkspaceInput['trpcClient']
}): Promise<PublicationAsset> {
  if (input.reuse?.revision === input.render.revision) return input.reuse
  const { assetId } = await saveExportToWorkspace({
    blob: input.render.blob,
    classification: 'export',
    fileName: buildExportFileName(input.render.mimeType),
    onProgress: input.onProgress,
    projectId: input.projectId,
    trpcClient: input.trpcClient,
  })
  return { assetId, revision: input.render.revision }
}

/** A post's attachment, as the composer's editor holds it. */
export type PublicationNode = ReturnType<typeof draftAssetNode>

/**
 * Render a kind and store its files, returning the attachments in order.
 *
 * Progress runs 0–60 while rendering and 60–100 while storing, so one bar
 * covers both. Each file reuses an asset this browser already stored for the
 * same revision.
 */
export async function preparePublication(
  kind: PublishKind,
  input: PublishRenderInput & {
    projectId?: string
    /** The workspace the assets belong to. */
    scope: string
    trpcClient: SaveToWorkspaceInput['trpcClient']
  }
): Promise<PublicationNode[]> {
  const report = input.onProgress
  const renders = await renderPublications(kind, {
    ...input,
    onProgress: (progress) => report?.(Math.round(progress * 0.6)),
  })
  const nodes: PublicationNode[] = []
  for (const [index, render] of renders.entries()) {
    const share = 40 / renders.length
    const stored = await uploadPublication({
      onProgress: (progress) => report?.(Math.round(60 + share * index + (share * progress) / 100)),
      projectId: input.projectId,
      render,
      reuse: rememberedPublication(input.scope, render.revision),
      trpcClient: input.trpcClient,
    })
    rememberPublication(input.scope, stored)
    nodes.push(draftAssetNode({ id: stored.assetId, mediaType: render.mimeType }))
  }
  report?.(100)
  return nodes
}

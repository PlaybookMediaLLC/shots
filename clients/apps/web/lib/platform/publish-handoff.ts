'use client'

import { canonicalJson } from '@/lib/design/canonical-json'
import { exportDesignDocument } from '@/lib/design/export'
import { exportStill, type StillFormat, stillFormatSchema } from '@/lib/export/export-design'
import { formatHasControl, type OutputFormat, type QualityPresetName } from '@/lib/export/formats'
import { canvasTarget } from '@/lib/export/sizes'
import { contentHash } from '@/lib/write/versions'
import {
  buildExportFileName,
  saveExportToWorkspace,
  type SaveToWorkspaceInput,
} from '@/lib/workspace/save-export'

/**
 * The editor's half of publishing: a design becomes the exact bytes a social
 * post carries.
 *
 * `Editor state → rendered blob → workspace asset`, after which the content
 * draft API owns the post. Nothing here knows about destinations, captions or
 * scheduling: the draft the dialog creates goes through the same
 * `draftsApi.create` and `draftsApi.schedule` calls the composer uses, so a
 * post started in the editor is an ordinary draft from the moment it exists.
 *
 * The render is the editor's own export pipeline (`exportStill`), never a
 * second renderer, so what publishes is what Export downloads.
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

/** Whether publishing has to leave the chosen export format to send a still image. */
export function publishFormatChanged(format: OutputFormat): boolean {
  return publishableFormat(format) !== format
}

/** How a publication export is produced; two renders of one revision match. */
export type PublishExportConfig = {
  format: StillFormat
  quality: QualityPresetName
  scale: number
  transparent: boolean
}

/** A rendered composition, with the revision of the design it was taken from. */
export type PublicationRender = {
  blob: Blob
  config: PublishExportConfig
  height: number
  mimeType: string
  /** The design and settings these bytes came from; see {@link compositionRevision}. */
  revision: string
  width: number
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
export function compositionRevision(document: unknown, config: PublishExportConfig): string {
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

/** An image's pixel size, which the destinations' media rules are checked against. */
async function measure(blob: Blob): Promise<{ height: number; width: number }> {
  const bitmap = await createImageBitmap(blob)
  try {
    return { height: bitmap.height, width: bitmap.width }
  } finally {
    bitmap.close()
  }
}

/**
 * Render the composition as the still image a post will carry.
 *
 * The revision is read before the stage is captured, so the bytes are
 * labelled with the design they were taken from even if the editor changes
 * while the capture runs; the caller compares it with the live revision and
 * offers a fresh render rather than publishing a stale image.
 */
export async function renderPublication(input: {
  canvas: { height: number; width: number }
  config: PublishExportConfig
  /** Base file name, usually the screenshot's name. */
  name: string
  signal?: AbortSignal
}): Promise<PublicationRender> {
  const { config } = input
  const revision = compositionRevision(exportDesignDocument({ keepLocalSources: true }), config)
  const [file] = await exportStill({
    allSlides: false,
    format: config.format,
    name: input.name,
    // A still publication never produces a PDF, so the setting cannot apply.
    pdfCompression: 'jpeg',
    quality: config.quality,
    scale: config.scale,
    signal: input.signal,
    targets: [canvasTarget(input.canvas.width, input.canvas.height)],
    transparent: config.transparent,
  })
  if (!file || file.blob.size === 0) throw new Error('The design produced no image to publish.')
  return { ...(await measure(file.blob)), blob: file.blob, config, mimeType: file.blob.type, revision }
}

/** A render saved as a workspace asset, with the revision it was made from. */
export type PublicationAsset = { assetId: string; revision: string }

/**
 * The publication asset this browser stored last.
 *
 * The publish dialog is unmounted when it closes, so without this, opening it
 * again on an unchanged design would store the same pixels under a second
 * asset id and leave the first orphaned. One entry is enough: it answers
 * "publish, look at it, close, publish again", and any edit in between
 * changes the revision and stores a new asset as it should.
 *
 * `scope` is the workspace the asset belongs to, so an asset is never offered
 * to a workspace that cannot read it.
 */
let lastPublication: { asset: PublicationAsset; scope: string } | null = null

/** The stored asset for this exact design and export, if this browser still has one. */
export function rememberedPublication(
  scope: string,
  revision: string
): PublicationAsset | undefined {
  return lastPublication?.scope === scope && lastPublication.asset.revision === revision
    ? lastPublication.asset
    : undefined
}

/** Remember a stored asset for {@link rememberedPublication}. */
export function rememberPublication(scope: string, asset: PublicationAsset): void {
  lastPublication = { asset, scope }
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

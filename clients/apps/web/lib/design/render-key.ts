import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical-json'
import type { DesignDocument } from './document'

/**
 * Cache key for one rendered image of a design.
 *
 * Two renders with the same key produce the same pixels: same document, same
 * output format and scale, and the same bytes behind every referenced image.
 * Each `asset:<id>` is hashed as its content fingerprint rather than its id,
 * so a recapture that stores the same bytes under a new asset id still hits
 * the cache. Object keys are sorted so equivalent documents hash the same
 * regardless of how their JSON was built.
 */

export const RENDER_KEY_VERSION = 2

/** An `asset:<id>` reference as its content fingerprint, when one is known. */
function byContent(assets: Record<string, string>) {
  return (text: string) => {
    if (!text.startsWith('asset:')) return text
    const fingerprint = assets[text.slice('asset:'.length)]
    return fingerprint ? `asset:${fingerprint}` : text
  }
}

export function designRenderKey(input: {
  /**
   * Content fingerprint per referenced asset id: its SHA-256, or a stand-in
   * that includes the id, since only a content hash may be shared by two ids.
   */
  assets: Record<string, string>
  document: DesignDocument
  options: { format: string; scale: number }
}): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        { document: input.document, options: input.options, version: RENDER_KEY_VERSION },
        byContent(input.assets)
      )
    )
    .digest('hex')
}

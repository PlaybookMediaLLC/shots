/**
 * Filename-to-caption helpers for the "Use file name as caption" preference.
 *
 * Rules:
 * - Applies only to video uploads/selections (video/* MIME type or known video extension).
 * - Preserves the filename stem verbatim after stripping path segments and the
 *   final file extension, trimmed of leading/trailing whitespace.
 * - Never overwrites an existing non-empty caption.
 */

const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|mov|m4v|webm|ogv|ogg|mkv|avi|wmv|flv|3gp|mts|m2ts)$/i

/** Whether a file name or MIME type represents a video asset. */
export function isVideoAsset(input: { fileName?: string | null; mimeType?: string | null }): boolean {
  if (input.mimeType && input.mimeType.trim().toLowerCase().startsWith('video/')) {
    return true
  }
  if (input.fileName && VIDEO_EXTENSION_PATTERN.test(input.fileName.trim())) {
    return true
  }
  return false
}

/**
 * Extracts the verbatim stem from a file name by removing any directory prefix
 * and stripping the last extension (preserving hidden dotfiles gracefully).
 */
export function captionFromFileName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').trim()
  if (!base) return ''
  const lastDot = base.lastIndexOf('.')
  // Keep leading dot-only filenames (e.g. ".mp4") from becoming empty unless they are just an extension.
  const stem = lastDot > 0 ? base.slice(0, lastDot) : lastDot === 0 ? '' : base
  return stem.trim()
}

/**
 * Returns the filename-derived caption when the preference is enabled, the
 * current caption is empty/whitespace-only, and the asset is a video.
 * Otherwise returns null (meaning: leave the current caption untouched).
 */
export function filenameCaptionIfEligible(params: {
  currentCaption: string
  enabled: boolean
  fileName?: string | null
  mimeType?: string | null
}): string | null {
  if (!params.enabled) return null
  if (params.currentCaption.trim().length > 0) return null
  if (!params.fileName) return null
  if (!isVideoAsset({ fileName: params.fileName, mimeType: params.mimeType })) return null
  const derived = captionFromFileName(params.fileName)
  return derived.length > 0 ? derived : null
}

/**
 * Canonical JSON for cache keys.
 *
 * Object keys are sorted and undefined entries dropped, so two structures
 * that mean the same thing produce the same text however their JSON was
 * built. `replaceString` rewrites leaf strings on the way out, which the
 * design render key uses to key an image by its content rather than its id.
 *
 * This holds no hash of its own: the server hashes with `node:crypto`
 * (`designRenderKey`) and the browser with `contentHash`, and both must
 * canonicalize the same way.
 */

/** The value with sorted keys, ready for `JSON.stringify`. */
export function canonicalValue(
  value: unknown,
  replaceString?: (text: string) => string
): unknown {
  if (typeof value === 'string') return replaceString ? replaceString(value) : value
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, replaceString))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry, replaceString)])
    )
  }
  return value
}

/** {@link canonicalValue} as JSON text. */
export function canonicalJson(
  value: unknown,
  replaceString?: (text: string) => string
): string {
  return JSON.stringify(canonicalValue(value, replaceString))
}

/**
 * The stable address of a workspace asset; it redirects to a signed URL.
 * Kept apart from the editor services so server code can build it without
 * loading the browser upload helpers.
 */
export function assetContentUrl(assetId: string): string {
  return `/api/v1/assets/${encodeURIComponent(assetId)}/content`
}

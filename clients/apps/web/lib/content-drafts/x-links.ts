import twitterText from 'twitter-text'

/**
 * Extracts every URL that X will linkify into a t.co entity (both scheme'd URLs
 * and bare domains), matching `helpers.XLinkSpans` on the Go backend 1:1.
 */
export function extractXLinks(text: string): string[] {
  if (!text.includes('.')) return []
  return twitterText
    .extractUrlsWithIndices(text, { extractUrlsWithoutProtocol: true })
    .map((entry) => entry.url)
}

/** How many X-linkified URLs appear in `text`. */
export function countXLinks(text: string): number {
  return extractXLinks(text).length
}

/** Whether `text` contains any URL that X will linkify into a t.co entity. */
export function hasXLinks(text: string): boolean {
  return countXLinks(text) > 0
}

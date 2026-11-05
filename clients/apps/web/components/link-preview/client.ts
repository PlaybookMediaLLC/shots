import type { LinkPreview, LinkPreviewAgent } from '@/lib/api/contracts/link-preview'
import { safeReturnPath } from '@/lib/platform/navigation'

/** The URL as typed, with `https://` added when no scheme was given; null when it is not a web URL. */
export function normalizeUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (
      !/^https?:\/\//i.test(trimmed) &&
      !url.hostname.includes('.') &&
      url.hostname !== 'localhost' &&
      !url.hostname.startsWith('[')
    )
      return null
    return url.toString()
  } catch {
    return null
  }
}

/**
 * This page's address after checking `url`: the check's query, plus a safe
 * `returnTo` and the brand `set` it was opened with, so a finished check
 * keeps the way back to the work it came from.
 */
export function checkAddress(current: string, url: string, agent: LinkPreviewAgent): string {
  const address = new URL(current)
  const query = new URLSearchParams()
  const returnTo = safeReturnPath(address.searchParams.get('returnTo'), '')
  if (returnTo) query.set('returnTo', returnTo)
  const set = address.searchParams.get('set')
  if (set) query.set('set', set)
  query.set('url', url)
  if (agent !== 'default') query.set('agent', agent)
  address.search = query.toString()
  return address.toString()
}

/** Parse one URL per line, retaining invalid lines so they cannot silently disappear. */
export function parseUrlLines(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return {
    urls: [...new Set(lines.map(normalizeUrl).filter((url) => url !== null))],
    invalid: lines.filter((line) => !normalizeUrl(line)),
  }
}

/** A failed read, keeping the status that says whether the page or the request was at fault. */
export class LinkPreviewRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/** Ask the server to read `url` as `agent`. Throws with the API's message on failure. */
export async function requestPreview(
  url: string,
  agent: LinkPreviewAgent,
  signal?: AbortSignal
): Promise<LinkPreview> {
  const query = new URLSearchParams({ agent, url })
  const response = await fetch(`/api/v1/link-preview?${query}`, { signal })
  const body = await response.json().catch(() => null)
  if (!response.ok)
    throw new LinkPreviewRequestError(
      body?.message ?? 'The page could not be read.',
      response.status
    )
  return body as LinkPreview
}

/** Copy `text`, reporting whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Save `blob` as a file named `name`. */
export function downloadBlob(name: string, blob: Blob) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

/** Save `text` as a file named `name`. */
export function downloadText(name: string, text: string, type: string) {
  downloadBlob(name, new Blob([text], { type }))
}

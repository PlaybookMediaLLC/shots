import { z } from 'zod'
import { codeDocumentSchema } from '@/lib/code-studio/document'

/**
 * Share links: a published export (an image, or a video with a poster)
 * at an unguessable URL. The link page carries Open Graph tags, so the same
 * URL previews in Slack, X, LinkedIn, and the Link Preview checker.
 */

/** Who may open a link: anyone with it, or members of its workspace. */
export const shareAccessSchema = z.enum(['PUBLIC', 'WORKSPACE'])
/** A share link's access. */
export type ShareAccess = z.infer<typeof shareAccessSchema>

/** How long a new link lasts. */
export const shareExpirySchema = z.enum(['never', '1d', '7d', '30d'])
/** A share link lifetime. */
export type ShareExpiry = z.infer<typeof shareExpirySchema>

/** Labels for the access choices. */
export const SHARE_ACCESS_LABELS: Record<ShareAccess, string> = {
  PUBLIC: 'Anyone with the link',
  WORKSPACE: 'Workspace members',
}

/** Labels for the lifetimes. */
export const SHARE_EXPIRY_LABELS: Record<ShareExpiry, string> = {
  '1d': '1 day',
  '30d': '30 days',
  '7d': '7 days',
  never: 'Never',
}

const EXPIRY_DAYS: Record<ShareExpiry, number | null> = { '1d': 1, '30d': 30, '7d': 7, never: null }

/** The expiry instant for a lifetime, as an ISO string, or null for never. */
export function expiryDate(choice: ShareExpiry, now: Date = new Date()): string | null {
  const days = EXPIRY_DAYS[choice]
  return days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString()
}

const title = z.string().trim().min(1, 'Add a title.').max(200)
const description = z.string().trim().max(5000)
const altText = z.string().trim().max(1500)

/** Publish an uploaded asset. */
export const shareLinkCreateSchema = z.object({
  access: shareAccessSchema,
  altText: altText.optional(),
  assetId: z.uuid(),
  description: description.optional(),
  expiry: shareExpirySchema,
  posterAssetId: z.uuid().optional(),
  projectId: z.string().cuid().optional(),
  title,
  /** A Code Studio document to embed as copyable text beside the image. */
  code: codeDocumentSchema.optional(),
})
/** Input to publish an asset. */
export type ShareLinkCreateInput = z.infer<typeof shareLinkCreateSchema>

/** Change a live link. Null clears a text field. */
export const shareLinkUpdateSchema = z.object({
  access: shareAccessSchema.optional(),
  altText: altText.nullable().optional(),
  description: description.nullable().optional(),
  expiry: shareExpirySchema.optional(),
  id: z.string().cuid(),
  title: title.optional(),
})
/** Input to change a link. */
export type ShareLinkUpdateInput = z.infer<typeof shareLinkUpdateSchema>

/** A link as its workspace sees it. */
export const shareLinkSchema = z.object({
  access: shareAccessSchema,
  altText: z.string().nullable(),
  assetId: z.string(),
  createdAt: z.coerce.date(),
  description: z.string().nullable(),
  expiresAt: z.coerce.date().nullable(),
  height: z.number().int().nullable(),
  id: z.string(),
  mediaType: z.string(),
  posterAssetId: z.string().nullable(),
  projectId: z.string().nullable(),
  revokedAt: z.coerce.date().nullable(),
  title: z.string(),
  token: z.string(),
  updatedAt: z.coerce.date(),
  width: z.number().int().nullable(),
})
/** A share link. */
export type ShareLink = z.infer<typeof shareLinkSchema>

/** A share token: 24 random bytes, base64url. */
export const shareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/)

/** The media a link serves: the artifact, or its poster image. */
export const shareMediaVariantSchema = z.enum(['media', 'poster'])
/** A share media variant. */
export type ShareMediaVariant = z.infer<typeof shareMediaVariantSchema>

/** True while a link can be opened. */
export function isLive(
  link: Pick<ShareLink, 'expiresAt' | 'revokedAt'>,
  now: Date = new Date()
): boolean {
  return !link.revokedAt && (!link.expiresAt || link.expiresAt > now)
}

/** The share page of a token. */
export function shareUrl(origin: string, token: string): string {
  return new URL(`/s/${encodeURIComponent(token)}`, origin).toString()
}

/** The media (or poster) bytes of a token, for embeds and link previews. */
export function shareMediaUrl(
  origin: string,
  token: string,
  variant: ShareMediaVariant = 'media'
): string {
  const url = new URL(`/api/share/${encodeURIComponent(token)}/media`, origin)
  if (variant === 'poster') url.searchParams.set('variant', 'poster')
  return url.toString()
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[char]!
  )

/** Copyable embeds of a published link: an iframe, plain HTML, and Markdown. */
export function embedSnippets(
  origin: string,
  link: Pick<ShareLink, 'altText' | 'height' | 'mediaType' | 'title' | 'token' | 'width'>
) {
  const page = shareUrl(origin, link.token)
  const media = shareMediaUrl(origin, link.token)
  const width = link.width ?? 1200
  const height = link.height ?? 675
  const alt = escapeHtml(link.altText ?? link.title)
  const isVideo = link.mediaType.startsWith('video/')
  return {
    html: isVideo
      ? `<video src="${media}" width="${width}" height="${height}" controls playsinline title="${escapeHtml(link.title)}"></video>`
      : `<a href="${page}"><img src="${media}" width="${width}" height="${height}" alt="${alt}" loading="lazy" /></a>`,
    iframe: `<iframe src="${page}/embed" width="${width}" height="${height}" style="border:0;max-width:100%;aspect-ratio:${width}/${height};height:auto" title="${escapeHtml(link.title)}" loading="lazy" allowfullscreen></iframe>`,
    markdown: isVideo
      ? `[${link.title.replace(/[[\]]/g, '')}](${page})`
      : `[![${(link.altText ?? link.title).replace(/[[\]]/g, '')}](${media})](${page})`,
  }
}

import twitterText from 'twitter-text'
import { z } from 'zod'
import { draftChannelSchema, type Numbering } from '@/lib/write/document'
import { numberCaptions } from '@/lib/write/numbering'
import { LABELS, mediaProblems } from '@/lib/write/media-rules'
import { xLength } from './x-length'

/**
 * Plate JSON to a social caption (RFC 013). Social channels take plain text,
 * so this flattens every node the editor can produce, and reports each thing
 * it had to degrade so the composer can warn before scheduling. Pure: the
 * composer previews with it and the schedule route serializes with it, so the
 * preview is what gets posted.
 */

/** Channels a draft can be scheduled to (defined with the Write document). */
export { draftChannelSchema }

/** One of {@link draftChannelSchema}. */
export type DraftChannel = z.infer<typeof draftChannelSchema>

/** What serializing had to change. */
export const degradationKindSchema = z.enum([
  'formatting',
  'table',
  'math',
  'footnotes',
  'embed',
  'extra-images',
  'thread',
  'unsupported',
])

/** One of {@link degradationKindSchema}. */
export type DegradationKind = z.infer<typeof degradationKindSchema>

/** A change the composer warns about before scheduling. */
export type Degradation = { kind: DegradationKind; message: string }

/** A durable attachment, kept with the same normalized post used for publication. */
export type SerializedMedia = {
  assetId: string
  id: string
  kind: 'image' | 'gif' | 'video'
  alt: string
  photoTags: { providerId: string; label: string; handle?: string }[]
  sourceAssetId?: string
  mimeType?: string
  width?: number
  height?: number
  processingStatus: 'ready' | 'pending' | 'failed'
}

/** One post of a thread: its text and its workspace images in order. */
export type SerializedPost = {
  media: SerializedMedia[]
  assetIds: string[]
  caption: string
  /**
   * The post's group in the body: its index among the post breaks' groups,
   * so its settings and identity can be found. Posts joined into one post
   * for a channel without threads take the first group.
   */
  group: number
  /** Images in the post, uploaded or still to render. */
  images: number
  length: number
  /** Uploaded videos among the post's media. */
  videos: number
}

/** Channels that post a thread as replies; the others post it as one post. */
export const THREAD_CHANNELS: ReadonlySet<DraftChannel> = new Set([
  'x',
  'threads',
  'bluesky',
  'mastodon',
])

/**
 * Each channel's caption limit, as the backend checks it
 * (`draftChannelLimits` in server/internal/product/content_draft_schedule.go).
 */
export const DRAFT_CHANNEL_LIMITS: Record<DraftChannel, number> = {
  bluesky: 300,
  tiktok: 2000,
  youtube: 5000,
  instagram: 2_200,
  linkedin: 3_000,
  mastodon: 500,
  threads: 500,
  x: 280,
}

/** The block that starts the next post of a thread. */
export const POST_BREAK = 'post_break'

/**
 * An atomic mention of an account on a platform, picked from a lookup: its
 * label, the platform's id for it, and whether it names a person or an
 * organization. It never splits, and serializes the way its platform reads.
 */
export const SOCIAL_MENTION = 'social_mention'

/**
 * A social mention as its channel writes it: LinkedIn's annotation
 * `@[Name](urn:li:organization:1)` when the mention is LinkedIn's, the
 * handle elsewhere, and the plain label when nothing better is known.
 */
function socialMentionText(node: PlateNode, channel: DraftChannel): string {
  const label = String(node.label ?? '')
  const id = String(node.providerId ?? '')
  const handle = String(node.handle ?? '')
  if (
    node.platform === 'linkedin' &&
    channel === 'linkedin' &&
    /^urn:li:(?:organization:[0-9]{1,30}|person:[A-Za-z0-9_-]{1,100})$/.test(id)
  ) {
    const escapedLabel = label.replace(/[\\|{}@[\]()<>#*_~]/g, '\\$&')
    return `@[${escapedLabel}](${id})`
  }
  if (node.platform === channel && handle) return `@${handle.replace(/^@/, '')}`
  return label
}

/** How a caption is limited and numbered for one account. */
export type SerializeOptions = {
  /** The account's caption limit; the channel's standard limit when unset. */
  limit?: number
  /** Thread numbering, added to each post and counted in its length. */
  numbering?: Numbering
  /** The asset LinkedIn sends as the post's document; its file block is not an attachment. */
  documentAssetId?: string
}

/** A caption for one channel, with its limit and what it lost. */
export type SerializedCaption = {
  /** The post's workspace images in body order; each channel's media rules apply (lib/write/media-rules.ts). */
  assetIds: string[]
  caption: string
  channel: DraftChannel
  degradations: Degradation[]
  /** Blocking problems: the post cannot be scheduled as is. */
  errors: string[]
  /** UTF-16 length, as the channel and the backend count it; a thread's longest post. */
  length: number
  limit: number
  /**
   * What the channel posts, in order. A thread channel posts each post of
   * the draft (the first, then replies); any other channel posts one.
   */
  posts: SerializedPost[]
}

type PlateNode = {
  [key: string]: unknown
  children?: PlateNode[]
  text?: string
  type?: string
}

const CONNECTION_CHANNELS: Record<string, DraftChannel> = {
  bluesky: 'bluesky',
  tiktok: 'tiktok',
  youtube: 'youtube',
  instagram: 'instagram',
  'instagram-standalone': 'instagram',
  linkedin: 'linkedin',
  'linkedin-page': 'linkedin',
  mastodon: 'mastodon',
  'mastodon-custom': 'mastodon',
  mastodoncustom: 'mastodon',
  threads: 'threads',
  x: 'x',
  twitter: 'x',
}

/** The draft channel a connection platform publishes to, or null. */
export function channelForPlatform(platform: string): DraftChannel | null {
  return CONNECTION_CHANNELS[platform] ?? null
}

/** A connection's platform as people write it: "Instagram", never "instagram-standalone". */
export function platformLabel(platform: string): string {
  const channel = channelForPlatform(platform)
  return channel ? LABELS[channel] : platform
}

/** Text marks the editor applies; plain-text channels drop them all. */
const MARKS = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'code',
  'highlight',
  'kbd',
  'subscript',
  'superscript',
  'color',
  'backgroundColor',
  'fontFamily',
  'fontSize',
  'fontWeight',
]

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const DROPPED_BLOCKS: Partial<Record<string, DegradationKind>> = {
  audio: 'embed',
  file: 'embed',
  media_embed: 'embed',
  toc: 'unsupported',
  video: 'embed',
}
const SIMPLE_BLOCKS = new Set(['p', 'blockquote', 'callout', 'toggle', 'lic', 'li', 'caption'])
const CONTAINERS = new Set(['column_group', 'column', 'ul', 'ol'])

type Context = {
  invalidMediaMetadata: boolean
  media: SerializedMedia[]
  assetIds: string[]
  /** The channel the caption is for: mentions are written its way. */
  channel: DraftChannel
  /** Table and math blocks posted as rendered images, in body order. */
  blockImages: BlockImages | undefined
  /** How many table and math blocks the caption has passed. */
  blocks: number
  degraded: Map<DegradationKind, string>
  footnotes: Map<string, number>
  images: number
  /** Images not uploaded to the workspace. */
  unstored: number
  /** Uploaded files and audio, which no draft channel posts as an attachment. */
  unpublishable: number
  documentAssetId: string | undefined
  /** Uploaded videos, which go out as the post's media. */
  videos: number
}

/**
 * The draft's table and math blocks as images, in body order: each one's
 * rendered asset id, '' when it is rendered at scheduling (the preview), or
 * null when it could not be and posts as text. Positions, not block ids, tie
 * an image to its block: a live session gives the editor's blocks new ids.
 */
export type BlockImages = (string | null)[]

/** Block types the composer renders to an image for posting. */
const RENDERED_BLOCKS = new Set(['table', 'equation'])

/** How many table and math blocks the draft has (the composer renders each). */
export function renderableBlockCount(value: unknown): number {
  const count = (nodes: PlateNode[]): number =>
    nodes.reduce(
      (total, node) =>
        total +
        (RENDERED_BLOCKS.has(node.type ?? '')
          ? 1
          : node.type === 'footnoteDefinition'
            ? 0
            : count(node.children ?? [])),
      0
    )
  return count((Array.isArray(value) ? value : []) as PlateNode[])
}

/** A rendered block counts as an image; its text stays out of the caption. */
function renderedBlock(context: Context): boolean {
  const assetId = context.blockImages?.[context.blocks]
  context.blocks += 1
  if (assetId === undefined || assetId === null) return false
  context.images += 1
  if (assetId) {
    context.assetIds.push(assetId)
    context.media.push({
      assetId,
      id: assetId,
      kind: 'image',
      alt: '',
      photoTags: [],
      processingStatus: 'ready',
    })
  }
  return true
}

function degrade(context: Context, kind: DegradationKind, message: string): void {
  if (!context.degraded.has(kind)) context.degraded.set(kind, message)
}

function footnoteNumber(context: Context, identifier: string): number {
  const known = context.footnotes.get(identifier)
  if (known) return known
  const next = context.footnotes.size + 1
  context.footnotes.set(identifier, next)
  return next
}

/** An uploaded video is the post's media; it counts with the images. */
function collectVideo(node: PlateNode, context: Context): void {
  context.images += 1
  context.videos += 1
  collectAttachment(node, context, 'video')
}

function collectImage(node: PlateNode, context: Context): void {
  context.images += 1
  if (typeof node.assetId === 'string')
    collectAttachment(node, context, node.mimeType === 'image/gif' ? 'gif' : 'image')
  else context.unstored += 1
}

function collectAttachment(node: PlateNode, context: Context, kind: SerializedMedia['kind']): void {
  const assetId = String(node.assetId)
  const tags = z
    .array(
      z.object({
        providerId: z.string().regex(/^[0-9]{1,19}$/),
        label: z.string().min(1),
        handle: z.string().optional(),
      })
    )
    .max(10)
    .safeParse(node.photoTags ?? [])
  if (!tags.success) context.invalidMediaMetadata = true
  context.assetIds.push(assetId)
  context.media.push({
    assetId,
    id: typeof node.id === 'string' ? node.id : assetId,
    kind,
    alt: typeof node.alt === 'string' ? node.alt : '',
    photoTags: tags.success ? tags.data : [],
    sourceAssetId: typeof node.sourceAssetId === 'string' ? node.sourceAssetId : undefined,
    mimeType: typeof node.mimeType === 'string' ? node.mimeType : undefined,
    width:
      typeof node.width === 'number'
        ? node.width
        : typeof node.initialWidth === 'number'
          ? node.initialWidth
          : undefined,
    height:
      typeof node.height === 'number'
        ? node.height
        : typeof node.initialHeight === 'number'
          ? node.initialHeight
          : undefined,
    processingStatus:
      node.processingStatus === 'failed'
        ? 'failed'
        : node.processingStatus === 'pending'
          ? 'pending'
          : 'ready',
  })
}

/** The text of inline content: text leaves, links, mentions, tags, math. */
function inlineText(nodes: PlateNode[] | undefined, context: Context): string {
  return (nodes ?? [])
    .map((node) => {
      if (typeof node.text === 'string') {
        if (MARKS.some((mark) => node[mark])) {
          degrade(context, 'formatting', 'Bold, italic and other formatting are removed.')
        }
        return node.text
      }
      switch (node.type) {
        case 'img':
          // Imported documents can carry an image inside a paragraph.
          collectImage(node, context)
          return ''
        case 'a': {
          const label = inlineText(node.children, context).trim()
          const url = String(node.url ?? '')
          return !label || label === url ? url : `${label} (${url})`
        }
        case 'mention_input':
          return `${String(node.trigger ?? '@')}${typeof node.value === 'string' ? node.value : inlineText(node.children, context)}`
        case 'mention':
          return `@${String(node.value ?? '')}`
        case SOCIAL_MENTION:
          return socialMentionText(node, context.channel)
        case 'tag':
          return `#${String(node.value ?? '').replace(/^#/, '')}`
        case 'inline_equation':
          degrade(context, 'math', 'Math is posted as its LaTeX source.')
          return String(node.texExpression ?? '')
        case 'footnoteReference':
          degrade(context, 'footnotes', 'Footnotes become numbered notes at the end.')
          return `[${footnoteNumber(context, String(node.identifier ?? ''))}]`
        case 'date':
          return String(node.date ?? '')
        default:
          return inlineText(node.children, context)
      }
    })
    .join('')
}

/** A table as rows of cells padded to each column's width. */
function tableText(table: PlateNode, context: Context): string {
  degrade(context, 'table', 'Tables are posted as aligned text rows.')
  const rows = (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) =>
      (cell.children ?? [])
        .map((block) => blockText(block, context))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
  )
  // An empty row (the editor starts tables with spare rows) posts nothing.
  const filled = rows.filter((row) => row.some((cell) => cell))
  const widths: number[] = []
  for (const row of filled) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return filled
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
        .join(' | ')
    )
    .join('\n')
}

/** The marker of an indent-list item, or null for a non-list block. */
function listMarker(node: PlateNode, counters: Map<number, number>): string | null {
  const style = node.listStyleType
  if (typeof style !== 'string') return null
  const level = Math.max(1, Number(node.indent ?? 1))
  const indent = '  '.repeat(level - 1)
  for (const deeper of [...counters.keys()]) if (deeper > level) counters.delete(deeper)
  if (style === 'decimal') {
    const start = Number(node.listStart ?? 0)
    const next = start > 0 && !counters.has(level) ? start : (counters.get(level) ?? 0) + 1
    counters.set(level, next)
    return `${indent}${next}. `
  }
  counters.delete(level)
  if (style === 'todo') return `${indent}${node.checked ? '[x]' : '[ ]'} `
  return `${indent}- `
}

function blockText(node: PlateNode, context: Context): string {
  const type = node.type ?? 'p'
  if (type === 'placeholder') {
    context.unstored += 1
    return ''
  }
  if (type === 'img') {
    collectImage(node, context)
    return ''
  }
  if (type === 'video' && typeof node.assetId === 'string') {
    collectVideo(node, context)
    return ''
  }
  if ((type === 'file' || type === 'audio') && typeof node.assetId === 'string') {
    // An uploaded attachment is never left out silently; it blocks scheduling.
    if (node.assetId !== context.documentAssetId) context.unpublishable += 1
    return ''
  }
  const dropped = DROPPED_BLOCKS[type]
  if (dropped) {
    degrade(
      context,
      dropped,
      dropped === 'embed'
        ? 'Embedded video, audio and files are left out.'
        : 'The table of contents is left out.'
    )
    return ''
  }
  if (type === 'table' && renderedBlock(context)) {
    degrade(context, 'table', 'Tables are posted as images.')
    return ''
  }
  if (type === 'equation' && renderedBlock(context)) {
    degrade(context, 'math', 'Math blocks are posted as images.')
    return ''
  }
  if (type === 'table') return tableText(node, context)
  if (type === 'equation') {
    degrade(context, 'math', 'Math is posted as its LaTeX source.')
    return String(node.texExpression ?? '')
  }
  if (type === 'hr') return '———'
  if (type === 'code_block') {
    degrade(context, 'formatting', 'Bold, italic and other formatting are removed.')
    return (node.children ?? []).map((line) => inlineText(line.children, context)).join('\n')
  }
  if (CONTAINERS.has(type)) return serializeBlocks(node.children ?? [], context)
  if (!HEADINGS.has(type) && !SIMPLE_BLOCKS.has(type)) {
    degrade(context, 'unsupported', 'Some blocks are posted as their plain text.')
  }
  return inlineText(node.children, context)
}

/** Blocks joined with blank lines; consecutive list items stay together. */
function serializeBlocks(nodes: PlateNode[], context: Context): string {
  const counters = new Map<number, number>()
  const parts: { list: boolean; text: string }[] = []
  for (const node of nodes) {
    if (node.type === 'footnoteDefinition') continue
    const marker = listMarker(node, counters)
    if (marker === null) counters.clear()
    const text = blockText(node, context)
    if (!text.trim() && marker === null) continue
    parts.push({ list: marker !== null, text: marker === null ? text : marker + text })
  }
  return parts
    .map((part, index) => {
      if (index === 0) return part.text
      return (part.list && parts[index - 1].list ? '\n' : '\n\n') + part.text
    })
    .join('')
}

/** Footnote definitions in reference order, numbered like their markers. */
function footnotesText(nodes: PlateNode[], context: Context): string {
  const definitions = new Map<string, string>()
  const visit = (list: PlateNode[]) => {
    for (const node of list) {
      if (node.type === 'footnoteDefinition') {
        definitions.set(
          String(node.identifier ?? ''),
          inlineText(
            (node.children ?? []).flatMap((child) => child.children ?? [child]),
            context
          ).trim()
        )
      } else if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return [...context.footnotes.entries()]
    .map(([identifier, number]) => `[${number}] ${definitions.get(identifier) ?? ''}`.trim())
    .join('\n')
}

/** UTF-16 length, matching JavaScript's String.length and the Go backend. */
export function captionLength(caption: string): number {
  return caption.length
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Mastodon's Account::MENTION_RE (v4.7): `@user`, then an optional `@domain`. */
const mastodonMention =
  /(?<![=/\p{L}\p{M}\p{Nd}\p{Pc}])@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@([\p{L}\p{M}\p{Nd}\p{Pc}]+(?:[.-]+[\p{L}\p{M}\p{Nd}\p{Pc}]+)*))?/giu

/** twitter-text's end_mention_match: an at sign or a Latin accent right after (or `://`) means no mention. */
const mastodonMentionEnd =
  /[\u0300-\u036f@＠\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f\u0253\u0254\u0256\u0257\u0259\u025b\u0263\u0268\u026f\u0272\u0289\u028b\u02bb\u1e00-\u1eff]/

/**
 * The text Mastodon's StatusLengthValidator counts: each link with a protocol
 * becomes 23 characters and each mention drops its domain.
 */
function mastodonCountable(caption: string): string {
  // shortcut: stock twitter-text 3.1.0 finds the links; Mastodon's own regex also takes dat://, gemini:// and other protocols, any non-space path character and Unicode queries, and stops a path before a trailing '='. Port config/initializers/twitter_regex.rb on both sides if those links matter.
  const links = twitterText
    .extractUrlsWithIndices(caption, { extractUrlsWithoutProtocol: false })
    .map(({ indices: [start, end] }) => ({ start, end, text: 'x'.repeat(23) }))
  const mentions = [...caption.matchAll(mastodonMention)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      text: `@${match[1]}`,
      domain: match[2] ?? '',
    }))
    .filter(
      ({ end, domain }) =>
        !mastodonMentionEnd.test(caption[end] ?? '') &&
        !caption.startsWith('://', end) &&
        [...domain].length <= 253
    )
  let [countable, at] = ['', 0]
  for (const entity of [...links, ...mentions].sort((a, b) => a.start - b.start)) {
    if (entity.start < at) continue // overlaps the entity before, as remove_overlapping_entities drops it
    countable += caption.slice(at, entity.start) + entity.text
    at = entity.end
  }
  return countable + caption.slice(at)
}

/**
 * A caption's length as the platform counts it: X's weighted count of the
 * trimmed text (links are 23), Mastodon's (links with a protocol are 23,
 * mentions drop their domain, then grapheme clusters), grapheme clusters on
 * Bluesky, and UTF-16 units elsewhere. Go's `draftPostLength` is the same
 * rule; both are tested against
 * `server/internal/product/testdata/caption-length-cases.json`.
 */
export function platformCaptionLength(channel: DraftChannel, caption: string): number {
  // shortcut: JS trim() also strips U+FEFF and keeps U+0085, unlike Go's TrimSpace; align both if a caption starts or ends with one.
  if (channel === 'x') return xLength(caption.trim())
  if (channel === 'bluesky' || channel === 'mastodon') {
    const text = channel === 'mastodon' ? mastodonCountable(caption) : caption
    // Each printable ASCII character, tab and line feed is a grapheme: skip the segmenter.
    return /^[ -~\t\n]*$/.test(text) ? text.length : Array.from(graphemes.segment(text)).length
  }
  return captionLength(caption)
}

/** Where a caption passes a platform's limit, counted as the platform counts it. */
export function overflowAt(channel: DraftChannel, caption: string, limit: number): number {
  const fits = (at: number) => platformCaptionLength(channel, caption.slice(0, at)) <= limit
  if (channel !== 'x') {
    // Units and graphemes only grow as a prefix grows by whole code points, so
    // halve the range. X's link weighting can make a longer prefix count less.
    // So can Mastodon's links and mentions, but only from a word's first '@'
    // or five characters ('https') before its first '://' to the word's end:
    // halve the cuts outside those spans, then step back through the one span
    // where the count passes the limit.
    // shortcut: a long unspaced span (CJK text with a link before more text) steps back one code point at a time, like X; find tighter safe cuts if it gets slow.
    const risky = new Uint8Array(caption.length + 1)
    if (channel === 'mastodon')
      for (const word of caption.matchAll(/\S+/g)) {
        const entity = word[0].search(/:\/\/|@/)
        if (entity >= 0)
          risky.fill(1, word.index + Math.max(1, entity - 4), word.index + word[0].length)
      }
    const ends = [0]
    for (const character of caption) ends.push(ends[ends.length - 1] + character.length)
    const cuts = ends.filter((end) => !risky[end])
    let [low, high] = [0, cuts.length - 1]
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(cuts[middle])) low = middle
      else high = middle - 1
    }
    if (low === cuts.length - 1) return cuts[low]
    for (let index = ends.indexOf(cuts[low + 1]) - 1; ends[index] > cuts[low]; index--)
      if (fits(ends[index])) return ends[index]
    return cuts[low]
  }
  let at = caption.length
  while (at > 0 && !fits(at)) {
    const code = caption.charCodeAt(at - 1)
    at -= code >= 0xdc00 && code <= 0xdfff && at > 1 ? 2 : 1
  }
  return at
}

/**
 * Serialize a draft for one channel. The caption is trimmed, footnotes follow
 * the body, and the images are attached up to the channel's limit. Table and
 * math blocks in `blockImages` are posted as those images instead of text.
 * `text`, when set, is what this channel says instead of the body: plain
 * text, where two empty lines start the next post of a thread. The body's
 * images still go with it, on the first post.
 */
export function serializeDraft(
  value: unknown,
  channel: DraftChannel,
  blockImages?: BlockImages,
  text?: string,
  options: SerializeOptions = {}
): SerializedCaption {
  const nodes = (Array.isArray(value) ? value : []) as PlateNode[]
  const context: Context = {
    invalidMediaMetadata: false,
    assetIds: [],
    media: [],
    channel,
    blockImages,
    blocks: 0,
    degraded: new Map(),
    footnotes: new Map(),
    images: 0,
    unstored: 0,
    unpublishable: 0,
    documentAssetId: options.documentAssetId,
    videos: 0,
  }
  // Each post of a thread serializes on its own; footnotes close the last.
  const written = splitPosts(nodes).map((group, index) => {
    const [assets, images, videos] = [context.assetIds.length, context.images, context.videos]
    const caption = tidy(serializeBlocks(group, context))
    return {
      assetIds: context.assetIds.slice(assets),
      media: context.media.slice(assets),
      caption,
      group: index,
      images: context.images - images,
      length: 0,
      videos: context.videos - videos,
    }
  })
  const notes = footnotesText(nodes, context)
  const last = written[written.length - 1]
  if (notes && last) last.caption = tidy(`${last.caption}\n\n${notes}`)
  if (text?.trim()) {
    // The channel's own words replace the body's; only its images carry over.
    context.degraded.clear()
    const images = written.flatMap((post) => post.assetIds)
    const count = written.reduce((total, post) => total + post.images, 0)
    written.splice(
      0,
      written.length,
      ...text
        .split(/\n[ \t]*\n[ \t]*\n/)
        .map(tidy)
        .map((caption, index) => ({
          assetIds: index === 0 ? images : [],
          media: index === 0 ? context.media : [],
          caption,
          group: index,
          images: index === 0 ? count : 0,
          length: 0,
          videos: index === 0 ? written.reduce((total, post) => total + post.videos, 0) : 0,
        }))
    )
  }
  const filled = written.filter((post) => post.caption || post.images > 0)
  const thread = THREAD_CHANNELS.has(channel)
  if (!thread && filled.length > 1) {
    degrade(context, 'thread', `The thread is posted as one ${CHANNEL_NAMES[channel]} post.`)
  }
  const unnumbered: SerializedPost[] =
    thread || filled.length <= 1
      ? filled
      : [
          {
            assetIds: filled.flatMap((post) => post.assetIds),
            media: filled.flatMap((post) => post.media),
            caption: filled.map((post) => post.caption).join('\n\n'),
            group: filled[0].group,
            images: filled.reduce((total, post) => total + post.images, 0),
            length: 0,
            videos: filled.reduce((total, post) => total + post.videos, 0),
          },
        ]
  const numbered = thread
    ? numberCaptions(
        unnumbered.map((post) => post.caption),
        options.numbering
      )
    : unnumbered.map((post) => post.caption)
  const posts: SerializedPost[] = unnumbered.map((post, index) => ({
    ...post,
    caption: numbered[index],
    length: platformCaptionLength(channel, numbered[index]),
  }))

  const limit = options.limit ?? DRAFT_CHANNEL_LIMITS[channel]
  const errors: string[] = []
  if (context.invalidMediaMetadata)
    errors.push(
      'An attachment has invalid photo-tag metadata. Remove or replace its tags before scheduling.'
    )
  if (posts.length === 0 || posts.every((post) => !post.caption && post.images === 0)) {
    errors.push('Write something to post.')
  }
  posts.forEach((post, index) => {
    if (new Set(post.assetIds).size !== post.assetIds.length)
      errors.push(
        `Post ${index + 1} repeats the same stored attachment. Move the copy to another post or apply a distinct edit.`
      )
    if (channel === 'bluesky' && new TextEncoder().encode(post.caption).length > 3000) {
      errors.push(`Post ${index + 1} exceeds Bluesky's 3,000-byte text limit.`)
    }
    if (post.length <= limit) return
    errors.push(
      posts.length > 1
        ? `Post ${index + 1} is ${post.length} of ${limit} characters: shorten it for ${LABELS[channel]}.`
        : `${post.length} of ${limit} characters: shorten it for ${LABELS[channel]}.`
    )
  })
  // Each post's stored media against the channel's rules, as Go checks it;
  // an attachment known only by its kind is counted, not judged by format.
  posts.forEach((post, index) => {
    if (post.images > post.media.length) return
    const facts = post.media.map((media) => ({
      mimeType:
        media.mimeType ??
        (media.kind === 'gif' ? 'image/gif' : media.kind === 'video' ? 'video/*' : 'image/*'),
    }))
    for (const problem of mediaProblems(channel, facts))
      errors.push(posts.length > 1 ? `Post ${index + 1}: ${problem}` : problem)
  })
  if (context.unpublishable > 0) {
    errors.push(
      `${CHANNEL_NAMES[channel]} can't post an uploaded file or audio as an attachment. Remove it from the post; a PDF goes to LinkedIn through the document option.`
    )
  }
  if (context.unstored > 0) {
    errors.push('Upload every image to the workspace before scheduling.')
  }
  if (context.media.some((media) => media.processingStatus !== 'ready')) {
    errors.push('Wait for every attachment to finish processing, or replace failed media.')
  }
  return {
    assetIds: context.assetIds,
    caption: posts.map((post) => post.caption).join('\n\n'),
    channel,
    degradations: [...context.degraded].map(([kind, message]) => ({ kind, message })),
    errors,
    length: Math.max(0, ...posts.map((post) => post.length)),
    limit,
    posts,
  }
}

const CHANNEL_NAMES: Record<DraftChannel, string> = {
  bluesky: 'Bluesky',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  threads: 'Threads',
  x: 'X',
}

/** Top-level blocks grouped into posts at each post break. */
function splitPosts(nodes: PlateNode[]): PlateNode[][] {
  const posts: PlateNode[][] = [[]]
  for (const node of nodes) {
    if (node.type === POST_BREAK) posts.push([])
    else posts[posts.length - 1].push(node)
  }
  return posts
}

function tidy(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/** The draft's plain text, for search and the list preview. */
export function draftPlainText(value: unknown): string {
  return serializeDraft(value, 'linkedin').caption
}

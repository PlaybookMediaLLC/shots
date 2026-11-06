import { normalizeMentions } from './normalize-mentions'
import { POST_BREAK, serializeDraft } from '@/lib/content-drafts/serialize'
import {
  type DraftChannel,
  EMPTY_PLATFORM_VERSIONS,
  type PlateBody,
  type PlatformVersion,
  type PlatformVersions,
  PLATFORM_VERSIONS_SCHEMA,
  type PostSettings,
  postSettingsSchema,
  type VersionOptions,
} from '@/lib/write/document'

/**
 * Platform versions and post identity (RFC 025). The primary body is the
 * draft's; every other platform's version is synced (serialized from the
 * primary each time) or manual (its own body). Nothing here overwrites a
 * manual body: switching back to synced is an explicit call that says which
 * comment threads it orphans.
 *
 * A post starts at a post break. Every body starts with one, so the first
 * post has an identity and settings like the rest.
 */

type Node = Record<string, unknown> & { children?: Node[]; type?: string }

/** A new post id: short, random, and unique enough within one draft. */
export function newPostId(): string {
  return `p_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

/** A post break block: the start of a post, its id, and its settings. */
export type PostBreakNode = PostSettings & {
  children: { text: string }[]
  id: string
  type: string
}

/** A post break with an id, starting a post. */
export function postBreak(settings: PostSettings = {}): PostBreakNode {
  return { ...settings, children: [{ text: '' }], id: settings.id ?? newPostId(), type: POST_BREAK }
}

/**
 * The body with one leading post break and an id on every break. A body
 * written before posts had identities gains a leading break; two breaks in a
 * row at the start (two editors adding one at once) keep the first.
 */
export function normalizePosts(body: PlateBody): PlateBody {
  const nodes = [...(normalizeMentions(body) as Node[])]
  while (nodes.length > 1 && nodes[0]?.type === POST_BREAK && nodes[1]?.type === POST_BREAK) {
    nodes.splice(1, 1)
  }
  if (nodes[0]?.type !== POST_BREAK) nodes.unshift(postBreak())
  const seen = new Set<string>()
  return nodes.map((node) => {
    if (node.type !== POST_BREAK) return node
    const id = typeof node.id === 'string' && node.id && !seen.has(node.id) ? node.id : newPostId()
    seen.add(id)
    return node.id === id ? node : { ...node, id }
  }) as PlateBody
}

/** One post of a body: its id, settings, and blocks. */
export type BodyPost = { blocks: Node[]; id: string | null; settings: PostSettings }

/**
 * The body's posts in order. Blocks before the first break, in a body that
 * has none at the start, form a first post with no id.
 */
export function bodyPosts(body: PlateBody): BodyPost[] {
  const posts: BodyPost[] = []
  for (const node of body as Node[]) {
    if (node.type === POST_BREAK) {
      const parsed = postSettingsSchema.safeParse(node)
      const settings = parsed.success ? parsed.data : {}
      posts.push({ blocks: [], id: typeof node.id === 'string' ? node.id : null, settings })
    } else {
      if (posts.length === 0) posts.push({ blocks: [], id: null, settings: {} })
      posts[posts.length - 1].blocks.push(node)
    }
  }
  return posts
}

/**
 * Each post's settings by its group, as the serializer numbers groups: group
 * 0 holds blocks before any break (none in a normalized body), and group n
 * follows break n − 1.
 */
export function groupSettings(body: PlateBody): PostSettings[] {
  const groups: PostSettings[] = [{}]
  for (const node of body as Node[]) {
    if (node.type !== POST_BREAK) continue
    const parsed = postSettingsSchema.safeParse(node)
    groups.push(parsed.success ? parsed.data : {})
  }
  return groups
}

/** A stable hash of text, to notice the primary changed since a fork. */
export function contentHash(text: string): string {
  let hash = 2_166_136_261
  for (const character of text) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The primary's text as the platform would post it, for its hash. */
export function primaryHash(body: PlateBody, channel: DraftChannel): string {
  return contentHash(serializeDraft(body, channel).caption)
}

/** Plain text as a body: two empty lines start the next post (legacy per-channel text). */
export function textToBody(text: string): PlateBody {
  return text.split(/\n[ \t]*\n[ \t]*\n/).flatMap((post) => [
    postBreak(),
    ...post
      .trim()
      .split(/\n{2,}/)
      .map((paragraph) => ({ children: [{ text: paragraph }], type: 'p' })),
  ]) as PlateBody
}

/**
 * The versions document a draft is edited with: the stored one, plus any
 * legacy per-channel text that has no version yet, as a manual version. As
 * legacy text did, it keeps the primary body's images and videos on its
 * first post.
 */
export function readVersions(
  versions: PlatformVersions | undefined,
  channelText: Partial<Record<DraftChannel, string>> = {},
  primary: PlateBody = []
): PlatformVersions {
  const result: PlatformVersions = {
    schemaVersion: PLATFORM_VERSIONS_SCHEMA,
    versions: [...(versions ?? EMPTY_PLATFORM_VERSIONS).versions],
  }
  const media = mediaBlocks(primary)
  for (const [channel, text] of Object.entries(channelText) as [DraftChannel, string][]) {
    if (!text?.trim() || result.versions.some((version) => version.channel === channel)) continue
    const [first, ...rest] = bodyPosts(textToBody(text))
    const body = [
      postBreak(),
      ...(first?.blocks ?? []),
      ...structuredClone(media),
      ...rest.flatMap((post) => [postBreak(), ...post.blocks]),
    ] as PlateBody
    result.versions.push({ body, channel, mode: 'manual' })
  }
  return result
}

/** A body's uploaded images and videos, wherever they sit, in order. */
function mediaBlocks(body: PlateBody): Node[] {
  const found: Node[] = []
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if ((node.type === 'img' || node.type === 'video') && typeof node.assetId === 'string')
        found.push(node)
      else if (node.children) visit(node.children)
    }
  }
  visit(body as Node[])
  return found
}

/** A channel's version entry, or a synced one when it has none. */
export function versionFor(versions: PlatformVersions, channel: DraftChannel): PlatformVersion {
  return (
    versions.versions.find((version) => version.channel === channel) ?? { channel, mode: 'synced' }
  )
}

/** The body a channel publishes: its own when manual, the primary's otherwise. */
export function bodyFor(
  primary: PlateBody,
  versions: PlatformVersions,
  channel: DraftChannel
): PlateBody {
  const version = versionFor(versions, channel)
  return version.mode === 'manual' && version.body ? version.body : primary
}

/** The versions with one channel's entry replaced (or added). */
export function withVersion(versions: PlatformVersions, next: PlatformVersion): PlatformVersions {
  const others = versions.versions.filter((version) => version.channel !== next.channel)
  const empty = next.mode === 'synced' && !next.options
  return {
    schemaVersion: PLATFORM_VERSIONS_SCHEMA,
    versions: empty ? others : [...others, next],
  }
}

/** The versions with one channel's options set, keeping its mode and body. */
export function withOptions(
  versions: PlatformVersions,
  channel: DraftChannel,
  options: VersionOptions | undefined
): PlatformVersions {
  const current = versionFor(versions, channel)
  const cleaned =
    options && Object.values(options).some((value) => value !== undefined) ? options : undefined
  return withVersion(versions, { ...current, options: cleaned })
}

/**
 * The primary as a starting body for a channel's own version. A channel
 * without threads gets the posts joined into one; a thread channel keeps
 * them. Post ids are new, so the copy's posts are its own.
 */
export function adaptBody(primary: PlateBody, threads: boolean): PlateBody {
  const posts = bodyPosts(primary).filter((post) => post.blocks.length > 0)
  if (posts.length === 0) return [postBreak(), { children: [{ text: '' }], type: 'p' }] as PlateBody
  if (threads) {
    return posts.flatMap((post) => [
      postBreak({ ...post.settings, id: undefined }),
      ...structuredClone(post.blocks),
    ]) as PlateBody
  }
  return [
    postBreak({ ...posts[0].settings, id: undefined }),
    ...posts.flatMap((post) => structuredClone(post.blocks)),
  ] as PlateBody
}

/**
 * Make a channel's version manual from the primary as it is now: the body
 * the person will edit, the draft version it came from, and the primary's
 * hash, to say later when the primary has moved on.
 */
export function forkVersion(
  versions: PlatformVersions,
  channel: DraftChannel,
  primary: PlateBody,
  draftVersion: number,
  threads: boolean
): PlatformVersions {
  const current = versionFor(versions, channel)
  return withVersion(versions, {
    ...current,
    body: adaptBody(primary, threads),
    forkedFromVersion: draftVersion,
    mode: 'manual',
    sourceHash: primaryHash(primary, channel),
  })
}

/** The comment thread ids a body anchors, from its comment marks. */
export function commentThreads(body: PlateBody | undefined): string[] {
  const ids = new Set<string>()
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('comment_') && key !== 'comment_draft' && node[key]) {
          ids.add(key.slice('comment_'.length))
        }
      }
      if (node.children) visit(node.children)
    }
  }
  visit((body ?? []) as Node[])
  return [...ids]
}

/**
 * Switch a channel back to synced: an explicit choice that discards its
 * body. Returns the versions and the comment threads that lose their text.
 */
export function resyncVersion(
  versions: PlatformVersions,
  channel: DraftChannel
): { orphaned: string[]; versions: PlatformVersions } {
  const current = versionFor(versions, channel)
  return {
    orphaned: current.mode === 'manual' ? commentThreads(current.body) : [],
    versions: withVersion(versions, { channel, mode: 'synced', options: current.options }),
  }
}

/** Whether a manual version's source has changed since it was copied. */
export function primaryChanged(
  version: PlatformVersion,
  primary: PlateBody,
  channel: DraftChannel
): boolean {
  return (
    version.mode === 'manual' &&
    Boolean(version.sourceHash) &&
    version.sourceHash !== primaryHash(primary, channel)
  )
}

/**
 * How copy names each platform. "X" alone is too common a word, and "the limit
 * on X" is about X rather than written for it, so it needs a word for posting there.
 */
const PLATFORM_NAMES: Record<DraftChannel, { label: string; pattern: RegExp }> = {
  bluesky: { label: 'Bluesky', pattern: /\bbluesky\b/i },
  instagram: { label: 'Instagram', pattern: /\binstagram\b/i },
  linkedin: { label: 'LinkedIn', pattern: /\blinkedin\b/i },
  mastodon: { label: 'Mastodon', pattern: /\bmastodon\b/i },
  threads: { label: 'Threads', pattern: /\bThreads\b/ },
  tiktok: { label: 'TikTok', pattern: /\btiktok\b/i },
  x: { label: 'X', pattern: /\b[Tt]witter\b|\b(?:[Nn]ow|[Pp]ost(?:ed|ing|s)?|[Pp]ublish(?:ed|ing)?|[Ss]har(?:e|ed|ing)|[Ff]ollow(?: me| us)?|[Ff]ind (?:me|us)|[Jj]oin (?:me|us)) (?:on|to) X\b/ },
  youtube: { label: 'YouTube', pattern: /\byoutube\b/i },
}

/**
 * Another of the draft's platforms that this platform's copy names, which
 * usually means text written for there: "published to TikTok" going out on X.
 */
export function otherPlatformNamed(
  text: string,
  channel: DraftChannel,
  channels: readonly DraftChannel[]
): string | null {
  // A link to a platform is not copy about it.
  const copy = text.replace(/\S+\.[a-z]{2,}\S*/gi, '')
  const other = channels.find(
    (candidate) => candidate !== channel && PLATFORM_NAMES[candidate].pattern.test(copy)
  )
  return other ? PLATFORM_NAMES[other].label : null
}

/**
 * The main platform once the platforms in `enabled` are the ones publishing.
 * A main platform turned off hands over to the first one that follows it, so
 * nothing copies from a platform that will not post. One with its own text
 * cannot take over, because the main text would replace it: with only those
 * left, the main platform stays.
 */
export function mainAfterToggle(
  primary: DraftChannel,
  enabled: readonly DraftChannel[],
  versions: PlatformVersions
): DraftChannel {
  if (enabled.includes(primary)) return primary
  return enabled.find((channel) => versionFor(versions, channel).mode !== 'manual') ?? primary
}

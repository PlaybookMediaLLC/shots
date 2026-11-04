import { articleContent } from '@/lib/write/article'
import type { Engagement } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { youtubeOptionsSchema, tiktokOptionsSchema } from 'screenshot-studio-backend-sdk'
import {
  type BlockImages,
  type SerializedCaption,
  type SerializedPost,
  POST_BREAK,
  serializeDraft,
} from '@/lib/content-drafts/serialize'
import { previewMediaTypes } from '@/lib/write/preview-media'
import { engagementAutomation } from '@/lib/write/automation'
import {
  type AccountStanding,
  CAPABILITIES,
  captionLimit,
  kindAvailability,
  pollProblems,
} from '@/lib/write/capabilities'
import {
  type Article,
  type Automation,
  type DraftChannel,
  type DraftKind,
  type DraftTarget,
  type PlateBody,
  type PlatformVersions,
  type PostSettings,
  postSettingsSchema,
  replySettingsSchema,
  linkPreviewSchema,
} from '@/lib/write/document'
import { bodyFor, groupSettings, versionFor } from '@/lib/write/versions'

/**
 * What a draft publishes to one account (RFC 025): the same normalized
 * content the preview shows and the schedule sends. Built from the stored
 * primary body, the channel's version and its options, the draft's kind and
 * target, and the account's standing. Go checks the result again.
 */

/** A post's settings as the backend stores them on a scheduled post. */
export const publishOptionsSchema = z.object({
  youtube: youtubeOptionsSchema.optional(),
  tiktok: tiktokOptionsSchema.optional(),
  photoTagIds: z
    .array(z.string().regex(/^[0-9]{1,19}$/))
    .max(10)
    .optional(),
  linkPreview: linkPreviewSchema.optional(),
  taggedUserIds: z
    .array(z.string().regex(/^\d{1,19}$/))
    .max(10)
    .optional(),
  articleCoverAssetId: z.string().optional(),
  articleTitle: z.string().optional(),
  articleHtml: z.string().max(400_000).optional(),
  communityId: z.string().optional(),
  documentAssetId: z.string().optional(),
  documentTitle: z.string().optional(),
  firstComment: z.string().optional(),
  madeWithAi: z.boolean().optional(),
  paidPartnership: z.boolean().optional(),
  pollQuestion: z.string().optional(),
  quoteFirstPost: z.boolean().optional(),
  quoteRemoteId: z.string().optional(),
  replySettings: replySettingsSchema.exclude(['everyone']).optional(),
  shareWithFollowers: z.boolean().optional(),
  visibility: z.enum(['PUBLIC', 'CONNECTIONS']).optional(),
})

/** One of {@link publishOptionsSchema}. */
export type PublishOptions = z.infer<typeof publishOptionsSchema>

/** One destination of a schedule request, as Go takes it. */
export type PublicationTarget = {
  assetIds: string[]
  caption: string
  channelConnectionId: string
  options?: PublishOptions
  /** X follow-ups once live (Auto-RT, Auto-Plug). */
  autoActions?: Automation
  poll?: { durationMinutes: number; options: string[]; multiple?: boolean }
  replies?: {
    assetIds: string[]
    caption: string
    options?: PublishOptions
    poll?: { durationMinutes: number; options: string[]; multiple?: boolean }
  }[]
  replyTo?: string
}

/** The draft parts a publication is built from. */
export type PublicationDraft = {
  article: Article | null
  body: PlateBody
  /** The follow-ups the draft copied from its set (RFC 024), until its X version sets its own. */
  engagement?: Engagement
  kind: DraftKind
  platformVersions: PlatformVersions
  target: DraftTarget | null
}

/** One account the draft goes to. */
export type PublicationAccount = {
  channel: DraftChannel
  connectionId: string
  standing?: AccountStanding
}

/** A destination's publication: what it sends, how it previews, and what blocks it. */
export type Publication = {
  /** Preview-only kinds; the backend checks actual uploaded MIME before publication. */
  mediaTypes: Record<string, 'image' | 'video'>
  /** Blocking problems: nothing can be scheduled while any remain. */
  problems: string[]
  /** Each post's settings, by its index in `serialized.posts`. */
  settings: PostSettings[]
  serialized: SerializedCaption
  target: PublicationTarget
}

/** A post's settings as options: everyone's replies is the default, so it is left out. */
function postOptions(
  channel: DraftChannel,
  settings: PostSettings,
  first: boolean
): PublishOptions {
  const capabilities = CAPABILITIES[channel].settings
  const options: PublishOptions = {}
  if (
    capabilities.replySettings &&
    settings.replySettings &&
    settings.replySettings !== 'everyone'
  ) {
    options.replySettings = settings.replySettings
  }
  if (capabilities.disclosures) {
    if (settings.disclosures?.madeWithAi) options.madeWithAi = true
    if (settings.disclosures?.paidPartnership) options.paidPartnership = true
  }
  if (channel === 'x' && settings.photoTagIds?.length) options.photoTagIds = settings.photoTagIds
  if (['x', 'bluesky', 'mastodon'].includes(channel) && settings.quoteFirstPost && !first)
    options.quoteFirstPost = true
  return options
}

/** Follow-ups that do something, or undefined when none is on. */
export function activeAutomation(automation: Automation | undefined): Automation | undefined {
  if (!automation) return undefined
  const active: Automation = {}
  if (automation.retweets?.length) {
    active.retweets = automation.retweets
    if (automation.unretweetAfterMinutes)
      active.unretweetAfterMinutes = automation.unretweetAfterMinutes
  }
  if (automation.plugAtLikes) {
    active.plugAtLikes = automation.plugAtLikes
    active.plugMetric = automation.plugMetric ?? 'likes'
    active.plugText = automation.plugText
  }
  if (automation.repostAtLikes) active.repostAtLikes = automation.repostAtLikes
  if (automation.quoteAfterHours && automation.quoteText?.trim()) {
    active.quoteAfterHours = automation.quoteAfterHours
    active.quoteText = automation.quoteText
  }
  return Object.keys(active).length > 0 ? active : undefined
}

/** Options without empty fields, or undefined when nothing is set. */
function compact(options: PublishOptions): PublishOptions | undefined {
  const entries = Object.entries(options).filter(
    ([key, value]) =>
      value !== undefined && value !== '' && (value !== false || key === 'shareWithFollowers')
  )
  return entries.length > 0 ? (Object.fromEntries(entries) as PublishOptions) : undefined
}

/** The poll on the first post, as the platform takes it, with its problems. */
function firstPoll(
  channel: DraftChannel,
  settings: PostSettings | undefined,
  first: SerializedPost | undefined,
  media: number,
  standing?: AccountStanding
): { poll?: PublicationTarget['poll']; problems: string[]; question?: string } {
  const poll = settings?.poll
  if (!poll) return { problems: [] }
  const problems = pollProblems(channel, poll, media, standing)
  if (['x', 'mastodon', 'threads'].includes(channel) && !first?.caption.trim())
    problems.push('This poll asks the post’s text: write the question.')
  return {
    poll: {
      durationMinutes:
        channel === 'threads' && poll.durationMinutes === 1440 ? 0 : poll.durationMinutes,
      ...(poll.multiple ? { multiple: true } : {}),
      options: poll.options,
    },
    problems,
    question: CAPABILITIES[channel].poll?.question === 'field' ? poll.question?.trim() : undefined,
  }
}

/** Build what a draft publishes to one account. */
export function buildPublication(
  draft: PublicationDraft,
  account: PublicationAccount,
  blockImages?: BlockImages
): Publication {
  const { channel } = account
  const version = versionFor(draft.platformVersions, channel)
  const body = bodyFor(draft.body, draft.platformVersions, channel)
  const groups = groupSettings(body)
  const options = version.options ?? {}
  const article = draft.kind === 'article'
  const serialized = serializeDraft(body, channel, blockImages, undefined, {
    limit: article ? 100_000 : captionLimit(channel, account.standing),
    numbering: CAPABILITIES[channel].thread ? options.numbering : undefined,
    documentAssetId: channel === 'linkedin' ? options.document?.assetId : undefined,
  })
  const settings = serialized.posts.map((post) => groups[post.group] ?? {})
  const [first, ...rest] = serialized.posts
  const problems = [...serialized.errors]
  if (
    channel === 'youtube' &&
    (!options.youtube?.title.trim() ||
      options.youtube.title.trim().length < 2 ||
      !options.youtube.privacy ||
      options.youtube.madeForKids === undefined)
  )
    problems.push('Choose a YouTube title, privacy and audience before scheduling.')
  if (channel === 'tiktok') {
    const creator = account.standing?.tiktokCreator
    if (!creator)
      problems.push(
        'TikTok account permissions are unavailable. Refresh the account before scheduling.'
      )
    else if (options.tiktok) {
      const choice = options.tiktok
      if (!creator.privacyLevels.some((privacy) => privacy === choice.privacy))
        problems.push('Choose a privacy setting permitted by this TikTok account.')
      if (
        (choice.allowComments && creator.commentDisabled) ||
        (choice.allowDuet && creator.duetDisabled) ||
        (choice.allowStitch && creator.stitchDisabled)
      )
        problems.push('TikTok account settings do not permit the selected interactions.')
    }
    if (
      options.tiktok?.commercialContent &&
      !options.tiktok.brandOrganic &&
      !options.tiktok.brandedContent
    )
      problems.push('Indicate whether this TikTok content promotes your brand or another brand.')
    if (
      (options.tiktok?.brandOrganic || options.tiktok?.brandedContent) &&
      !options.tiktok.commercialContent
    )
      problems.push('Enable commercial content disclosure for promotional content.')
    if (!options.tiktok?.privacy)
      problems.push('Choose who can see this TikTok post in its options before scheduling.')
    if (!options.tiktok?.consent)
      problems.push('Confirm consent to send this video to TikTok in its options before scheduling.')
    if (options.tiktok?.brandedContent && options.tiktok.privacy === 'SELF_ONLY')
      problems.push('Branded TikTok content cannot be private.')
  }
  if (channel === 'x')
    settings.forEach((setting, index) => {
      if (setting.photoTagIds?.length && (article || !serialized.posts[index]?.images))
        problems.push('Photo tagging needs an attached photo on a regular X post.')
      if (setting.photoTagIds && new Set(setting.photoTagIds).size !== setting.photoTagIds.length)
        problems.push('Use distinct photo tag IDs.')
    })
  // Tolerant editor readers may omit malformed settings, but publishing must
  // never turn an invalid poll or audience selection into an ordinary post.
  body.forEach((node, index) => {
    if (node.type === POST_BREAK && !postSettingsSchema.safeParse(node).success)
      problems.push(`Check the post settings at block ${index + 1} before publishing.`)
  })
  const availability = kindAvailability(channel, draft.kind, account.standing)
  if (!availability.available) problems.push(availability.reason)
  if (
    ['x', 'mastodon'].includes(channel) &&
    (settings.some((setting, index) => index > 0 && setting.quoteFirstPost) ||
      (channel === 'x' && Boolean(options.automation?.quoteAfterHours)))
  ) {
    const quote = kindAvailability(channel, 'quote', account.standing)
    if (!quote.available) problems.push(quote.reason)
  }

  const cardFor = (caption: string, media: number) => {
    const card = options.linkPreviews?.find((card) => caption.includes(card.url))
    if (!card) return undefined
    if (card.removed && channel !== 'bluesky')
      problems.push('This provider has no verified API control for link preview removal.')
    if (channel !== 'bluesky') return undefined
    if (!card.removed && media > 0)
      problems.push('Remove the link preview or media before publishing to Bluesky.')
    return card
  }
  const documentMedia = channel === 'linkedin' && options.document ? 1 : 0
  if (documentMedia && (first?.images ?? 0) > 0) {
    problems.push('A LinkedIn document goes alone: remove the images or the document.')
  }
  const poll = firstPoll(
    channel,
    settings[0],
    first,
    (first?.images ?? 0) + documentMedia,
    account.standing
  )
  problems.push(...poll.problems)
  if (channel === 'linkedin' && draft.kind === 'quote' && settings[0]?.poll)
    problems.push('A LinkedIn reshare cannot contain a poll.')

  const photoTags = (post: SerializedPost | undefined): string[] => [
    ...new Set(post?.media.flatMap((media) => media.photoTags.map((tag) => tag.providerId)) ?? []),
  ]
  for (const post of serialized.posts) {
    const tags = photoTags(post)
    if (!tags.length) continue
    if (channel !== 'x')
      problems.push(
        'Photo tags are native X metadata. Remove the tags in this platform version before publishing.'
      )
    if (tags.length > 10 || tags.some((id) => !/^\d{1,19}$/.test(id)))
      problems.push('Choose up to ten distinct X accounts for photo tags.')
    if (post.media.some((media) => media.kind !== 'image'))
      problems.push('Photo tags require static images, without GIFs or video.')
    if (process.env.NEXT_PUBLIC_PLATFORM_X_PHOTO_TAGS !== 'true')
      problems.push(
        'Native X photo tagging is awaiting authorized account verification on this installation.'
      )
  }
  const firstOptions: PublishOptions = { ...postOptions(channel, settings[0] ?? {}, true) }
  if (channel === 'x' && photoTags(first).length) firstOptions.taggedUserIds = photoTags(first)
  if (channel === 'youtube') firstOptions.youtube = options.youtube
  if (channel === 'tiktok') firstOptions.tiktok = options.tiktok
  if (channel === 'x' && options.community) {
    firstOptions.communityId = options.community.id
    firstOptions.shareWithFollowers = options.community.shareWithFollowers ?? true
  }
  const firstCard = cardFor(first?.caption ?? '', (first?.images ?? 0) + (first?.videos ?? 0))
  if (firstCard) firstOptions.linkPreview = firstCard
  if (channel === 'linkedin') {
    if (options.visibility) firstOptions.visibility = options.visibility
    if (options.firstComment?.trim()) firstOptions.firstComment = options.firstComment.trim()
    if (options.document) {
      firstOptions.documentAssetId = options.document.assetId
      firstOptions.documentTitle = options.document.title
    }
  }
  if (poll.question) firstOptions.pollQuestion = poll.question
  const automation =
    channel === 'x'
      ? activeAutomation(options.automation ?? engagementAutomation(draft.engagement))
      : undefined
  if (automation?.plugAtLikes && !automation.plugText?.trim())
    problems.push('The auto plug needs its reply text.')
  let replyTo: string | undefined
  if (draft.kind === 'reply') {
    if (draft.target?.platform === channel && draft.target.remoteId) replyTo = draft.target.remoteId
    else problems.push('A reply names the X post it answers.')
  }
  if (draft.kind === 'quote') {
    if (draft.target?.platform === channel && draft.target.remoteId)
      firstOptions.quoteRemoteId = draft.target.remoteId
    else
      problems.push(
        `A quote on ${CAPABILITIES[channel].label} quotes a ${CAPABILITIES[channel].label} post.`
      )
  }
  if (article) {
    const rich = articleContent(body)
    firstOptions.articleHtml = rich.html
    problems.push(...rich.problems)
    serialized.degradations = serialized.degradations.filter(
      (item) => !['formatting', 'embed'].includes(item.kind)
    )
    if (serialized.posts.length > 1)
      problems.push('An article has one body. Remove thread breaks before publishing.')
    if (!draft.article?.title.trim()) problems.push('Give the article a title.')
    firstOptions.articleTitle = draft.article?.title.trim()
    firstOptions.articleCoverAssetId = draft.article?.coverAssetId
  }
  const target: PublicationTarget = {
    assetIds: first?.assetIds ?? [],
    caption: first?.caption ?? '',
    channelConnectionId: account.connectionId,
    ...(compact(firstOptions) ? { options: compact(firstOptions) } : {}),
    ...(automation ? { autoActions: automation } : {}),
    ...(poll.poll ? { poll: poll.poll } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(rest.length > 0
      ? {
          replies: rest.map((post, index) => {
            const replyOptions = compact({
              ...(channel === 'x' && photoTags(post).length
                ? { taggedUserIds: photoTags(post) }
                : {}),
              ...postOptions(channel, settings[index + 1] ?? {}, false),
              ...(cardFor(post.caption, post.images + post.videos)
                ? { linkPreview: cardFor(post.caption, post.images + post.videos) }
                : {}),
            })
            const replyPoll = firstPoll(
              channel,
              settings[index + 1],
              post,
              post.images,
              account.standing
            )
            problems.push(...replyPoll.problems.map((problem) => `Post ${index + 2}: ${problem}`))
            return {
              assetIds: post.assetIds,
              caption: post.caption,
              ...(replyOptions ? { options: replyOptions } : {}),
              ...(replyPoll.poll ? { poll: replyPoll.poll } : {}),
            }
          }),
        }
      : {}),
  }
  return {
    mediaTypes: previewMediaTypes(body),
    problems: [...new Set(problems)],
    serialized,
    settings,
    target,
  }
}

import { z } from 'zod'
import { tiktokCreatorSchema } from 'screenshot-studio-backend-sdk'
import { AUTO_DM_UNAVAILABLE } from '@/lib/write/automation'
import type { DraftChannel, DraftKind, PostPoll } from '@/lib/write/document'

/**
 * What each platform can publish (RFC 025), one typed entry per platform.
 * Every capability here is backed by the provider's documentation and the
 * adapter that sends it; the matrix in
 * docs/scheduling/typefully/write/implementation-matrix.md links the sources.
 * Go holds the same numbers (`draftChannelLimits`, `checkDraftExtras`).
 * Media rules live in lib/write/media-rules.ts, shared with Go.
 */

/** Whether a capability is live, or why it is not. */
export const availabilitySchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true) }),
  z.object({
    available: z.literal(false),
    /** What the person can do about it, when anything. */
    action: z.enum(['connect', 'reconnect', 'upgrade-account', 'none']),
    reason: z.string(),
  }),
])

/** One of {@link availabilitySchema}. */
export type Availability = z.infer<typeof availabilitySchema>

const AVAILABLE: Availability = { available: true }

/** A platform's poll rules: how many options, how long, which fields. */
export type PollRules = {
  durationsMinutes: readonly number[]
  durationRange?: { min: number; max: number }
  maxOptionLength: number
  maxOptions: number
  minOptions: number
  /** LinkedIn asks its own question; X uses the post's text. */
  question: 'field' | 'post-text'
  questionLimit: number
  /** Polls and media never go together on these platforms. */
  withMedia: false
}

/** What one platform can publish. */
export type PlatformCapabilities = {
  /** The caption limit for a standard account. */
  captionLimit: number
  /** The caption limit for an account the platform marks Premium, when it has one. */
  premiumCaptionLimit: number | null
  /** Draft kinds this platform takes. */
  kinds: readonly DraftKind[]
  label: string
  /** Mentions: how they are written and whether a lookup backs them. */
  mentions: 'handle' | 'annotation' | 'none'
  poll: PollRules | null
  /** Post-level settings the adapter sends. */
  settings: {
    community: boolean
    disclosures: boolean
    firstComment: boolean
    pdfDocument: boolean
    replySettings: boolean
    visibility: boolean
  }
  /** Threads: posts after the first go out as replies, up to this many posts. */
  thread: { maxPosts: number } | null
  /** Follow-ups once live: reposts at set times, a plug reply, direct messages. */
  automation: { directMessage: Availability; plug: Availability; retweet: Availability }
}

/** Follow-ups a platform does not have. */
const NO_AUTOMATION: PlatformCapabilities['automation'] = {
  directMessage: { action: 'none', available: false, reason: 'Follow-ups are for X posts.' },
  plug: { action: 'none', available: false, reason: 'Follow-ups are for X posts.' },
  retweet: { action: 'none', available: false, reason: 'Follow-ups are for X posts.' },
}

const MINUTES = { day: 1_440, hour: 60 }

/** X: threads, replies, quotes, polls, communities and disclosures (X API v2 `POST /2/tweets`). */
const X: PlatformCapabilities = {
  captionLimit: 280,
  kinds: ['standard', 'reply', 'quote', 'repurpose', 'article'],
  label: 'X',
  mentions: 'handle',
  poll: {
    durationRange: { min: 5, max: 10_080 },
    durationsMinutes: [
      5,
      30,
      MINUTES.hour,
      6 * MINUTES.hour,
      MINUTES.day,
      3 * MINUTES.day,
      7 * MINUTES.day,
    ],
    maxOptionLength: 25,
    maxOptions: 4,
    minOptions: 2,
    question: 'post-text',
    questionLimit: 280,
    withMedia: false,
  },
  premiumCaptionLimit: 25_000,
  settings: {
    community: true,
    disclosures: true,
    firstComment: false,
    pdfDocument: false,
    replySettings: true,
    visibility: false,
  },
  thread: { maxPosts: 25 },
  automation: {
    directMessage: { action: 'none', available: false, reason: AUTO_DM_UNAVAILABLE },
    plug: AVAILABLE,
    retweet: AVAILABLE,
  },
}

/** LinkedIn: one post, polls, PDF documents and organization mentions (Posts API). */
const LINKEDIN: PlatformCapabilities = {
  captionLimit: 3_000,
  kinds: ['standard', 'quote', 'repurpose'],
  label: 'LinkedIn',
  mentions: 'annotation',
  poll: {
    durationsMinutes: [MINUTES.day, 3 * MINUTES.day, 7 * MINUTES.day, 14 * MINUTES.day],
    maxOptionLength: 30,
    maxOptions: 4,
    minOptions: 2,
    question: 'field',
    questionLimit: 140,
    withMedia: false,
  },
  premiumCaptionLimit: null,
  settings: {
    community: false,
    disclosures: false,
    firstComment: true,
    pdfDocument: true,
    replySettings: false,
    visibility: true,
  },
  thread: null,
  automation: NO_AUTOMATION,
}

function simple(label: string, captionLimit: number, thread: boolean): PlatformCapabilities {
  return {
    captionLimit,
    kinds: ['standard', 'repurpose'],
    label,
    mentions: 'handle',
    poll: null,
    premiumCaptionLimit: null,
    settings: {
      community: false,
      disclosures: false,
      firstComment: false,
      pdfDocument: false,
      replySettings: false,
      visibility: false,
    },
    thread: thread ? { maxPosts: 25 } : null,
    automation: NO_AUTOMATION,
  }
}

/** Every platform's capabilities. */
export const CAPABILITIES: Record<DraftChannel, PlatformCapabilities> = {
  bluesky: { ...simple('Bluesky', 300, true), kinds: ['standard', 'repurpose', 'quote'] },
  instagram: { ...simple('Instagram', 2_200, false), mentions: 'handle' },
  linkedin: LINKEDIN,
  mastodon: { ...simple('Mastodon', 500, true), kinds: ['standard', 'repurpose', 'quote'] },
  threads: {
    ...simple('Threads', 500, true),
    poll: {
      durationsMinutes: [0],
      minOptions: 2,
      maxOptions: 4,
      maxOptionLength: 25,
      question: 'post-text',
      questionLimit: 500,
      withMedia: false,
    },
  },
  tiktok: { ...simple('TikTok', 2000, false), kinds: ['standard'], mentions: 'none' },
  youtube: { ...simple('YouTube', 5000, false), kinds: ['standard'], mentions: 'none' },
  x: X,
}

/** Publishing capabilities verified for the connected account. */
export const accountStandingSchema = z.object({
  tiktokCreator: tiktokCreatorSchema.nullish(),
  maxWeightedCharacters: z.union([z.literal(280), z.literal(25_000)]).nullish(),
  articles: z.boolean().nullish(),
  xQuotes: z.boolean().optional(),
  mastodonQuotes: z.boolean().nullish(),
  pollLimits: z
    .object({
      maxOptions: z.number().int().min(2).max(20),
      maxOptionCharacters: z.number().int().min(1).max(1000),
      minDurationSeconds: z.number().int().positive(),
      maxDurationSeconds: z.number().int().positive(),
    })
    .nullish(),
})

/** One verified account's capabilities; absent fields remain unknown. */
export type AccountStanding = z.infer<typeof accountStandingSchema>

/** The caption limit for one account, independent of an editable Premium label. */
export function captionLimit(channel: DraftChannel, account?: AccountStanding): number {
  const capabilities = CAPABILITIES[channel]
  return channel === 'x' && account?.maxWeightedCharacters
    ? account.maxWeightedCharacters
    : capabilities.captionLimit
}

/** Whether a platform takes a kind of draft, and why not. */
export function kindAvailability(
  channel: DraftChannel,
  kind: DraftKind,
  account?: AccountStanding
): Availability {
  if (!CAPABILITIES[channel].kinds.includes(kind)) {
    return {
      action: 'none',
      available: false,
      reason: `${CAPABILITIES[channel].label} does not take ${kind} drafts.`,
    }
  }
  if (channel === 'mastodon' && kind === 'quote' && account?.mastodonQuotes !== true)
    return {
      available: false,
      action: 'reconnect',
      reason:
        'Reconnect to a Mastodon server with native quotes and read:search/read:statuses permissions.',
    }
  if (channel === 'x' && kind === 'quote' && account?.xQuotes !== true) {
    return {
      action: 'none',
      available: false,
      reason:
        'X quote posts require Enterprise API access, which this connection has not verified.',
    }
  }
  if (kind === 'article' && account?.articles !== true) {
    return {
      action: account?.articles === false ? 'upgrade-account' : 'reconnect',
      available: false,
      reason:
        account?.articles === false
          ? 'This X account does not have verified Articles access. Connect an eligible account.'
          : 'Reconnect X to check this account’s Articles access.',
    }
  }
  return AVAILABLE
}

/**
 * The problems with a poll on a platform, each a sentence. X uses the post's
 * text as the question; LinkedIn needs its own.
 */
export function pollProblems(
  channel: DraftChannel,
  poll: PostPoll,
  mediaCount: number,
  standing?: AccountStanding
): string[] {
  const rules = pollRules(channel, standing)
  if (!rules)
    return [
      channel === 'mastodon'
        ? 'Reconnect Mastodon to verify this server’s poll limits.'
        : `${CAPABILITIES[channel].label} posts cannot carry a poll.`,
    ]
  const problems: string[] = []
  if (rules.question === 'post-text' && poll.question)
    problems.push('This poll uses the post text as its question.')
  if (poll.multiple && channel !== 'mastodon')
    problems.push('Multiple-choice polls are supported only on Mastodon.')
  const options = poll.options.map((option) => option.trim())
  if (rules.question === 'field') {
    const question = poll.question?.trim() ?? ''
    if (!question) problems.push('Ask the poll question.')
    else if ([...(poll.question ?? '')].length > rules.questionLimit)
      problems.push(`Keep the question to ${rules.questionLimit} characters.`)
  } else if (poll.question?.trim()) {
    problems.push('Use the post text as the poll question on this platform.')
  }
  if (options.length < rules.minOptions || options.length > rules.maxOptions) {
    problems.push(`A poll has ${rules.minOptions} to ${rules.maxOptions} options.`)
  }
  if (
    channel === 'mastodon' &&
    new Set(options.map((option) => option.toLowerCase())).size !== options.length
  )
    problems.push('Each poll choice must be distinct.')
  if (options.some((option) => !option)) problems.push('Fill in every option.')
  if (poll.options.some((option) => [...option].length > rules.maxOptionLength)) {
    problems.push(`Keep each option to ${rules.maxOptionLength} characters.`)
  }
  // Older Threads drafts stored the provider's one-day default as 1440.
  const duration = channel === 'threads' && poll.durationMinutes === 1440 ? 0 : poll.durationMinutes
  const validDuration =
    Number.isInteger(duration) &&
    (rules.durationRange
      ? duration >= rules.durationRange.min && duration <= rules.durationRange.max
      : rules.durationsMinutes.includes(duration))
  if (!validDuration) {
    problems.push(`Pick one of ${CAPABILITIES[channel].label}'s poll lengths.`)
  }
  if (mediaCount > 0 && !rules.withMedia) {
    problems.push(`${CAPABILITIES[channel].label} posts with a poll cannot have media.`)
  }
  return problems
}

/** Use the authenticated server's observed poll configuration; unknown limits stay unavailable. */
export function pollRules(channel: DraftChannel, standing?: AccountStanding): PollRules | null {
  if (channel === 'x') return { ...X.poll!, durationRange: { min: 5, max: 10_080 } }
  if (channel !== 'mastodon') return CAPABILITIES[channel].poll
  const limits = standing?.pollLimits
  if (!limits) return null
  const min = Math.ceil(limits.minDurationSeconds / 60),
    max = Math.floor(limits.maxDurationSeconds / 60)
  if (min > max) return null
  return {
    minOptions: 2,
    maxOptions: limits.maxOptions,
    maxOptionLength: limits.maxOptionCharacters,
    question: 'post-text',
    questionLimit: 0,
    withMedia: false,
    durationsMinutes: [Math.min(max, Math.max(min, 1440))],
    durationRange: { min, max },
  }
}

import 'server-only'

import type {
  BackendContentDraft,
  BackendContentDraftPost,
  BackendContentDraftCreate,
  BackendContentDraftListQuery,
  BackendContentDraftUpdate,
  BackendSharedContentDraft,
} from 'screenshot-studio-backend-sdk'
import type { OrganizationAccess, TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull, serviceBackend, withDates } from '@/lib/backend/sdk'
import { channelForPlatform, type DraftChannel } from '@/lib/content-drafts/serialize'
import { testHooksAllowed } from '@/lib/e2e-hooks'
import type { z } from 'zod'
import {
  revisionReasonSchema,
  type reviewContentDraftContract,
} from '@/lib/api/contracts/content-draft-platform'
import type { createPostSchema } from '@/lib/api/contracts/posts'
import { listBackendConnections } from '@/lib/tenant/publishing-backend'
import { buildPublication } from '@/lib/write/publication'
import { readVersions } from '@/lib/write/versions'
import {
  articleSchema,
  draftKindSchema,
  draftTargetSchema,
  EMPTY_PLATFORM_VERSIONS,
  platformVersionsSchema,
  primaryChannel,
} from '@/lib/write/document'
import { ScheduledPostError } from '@/lib/tenant/scheduled-posts'

/**
 * Content drafts for a workspace (RFC 013). The backend scopes every query to
 * the workspace, checks roles, the plan, and that attached assets and channels
 * are the workspace's, and refuses an update based on an older version with a
 * 409.
 */

/**
 * A draft as the web reads it: Dates for its timestamps, the Plate body as
 * is, and its Write document parsed at this boundary, so a malformed one
 * fails here instead of in the composer.
 */
export function readDraft(draft: BackendContentDraft) {
  const { article, body, kind, plannedFor, platformVersions, primaryPlatform, target, ...fields } =
    draft
  return {
    ...withDates(fields),
    article: article ? articleSchema.parse(article) : null,
    body: body as Record<string, unknown>[],
    kind: draftKindSchema.parse(kind ?? 'standard'),
    plannedFor: plannedFor ? new Date(plannedFor) : null,
    platformVersions: platformVersionsSchema.parse(platformVersions ?? EMPTY_PLATFORM_VERSIONS),
    primaryPlatform: primaryChannel(primaryPlatform),
    target: target ? draftTargetSchema.parse(target) : null,
  }
}

/** One page of the workspace's drafts, newest first. */
export async function listContentDrafts(
  context: TenantContext,
  query: BackendContentDraftListQuery
) {
  const page = await backendSDK(context).listContentDrafts(query)
  return {
    items: page.items.map(readDraft),
    nextCursor: page.nextCursor,
    pinned: (page.pinned ?? []).map(readDraft),
  }
}

/** Create a draft. */
export async function createContentDraft(context: TenantContext, input: BackendContentDraftCreate) {
  return readDraft(await backendSDK(context).createContentDraft(input))
}

/** A draft of this workspace, or null. */
export async function getContentDraft(context: TenantContext, id: string) {
  const draft = await orNull(backendSDK(context).getContentDraft(id))
  return draft ? readDraft(draft) : null
}

/** Update a draft based on `baseVersion`; null when it is not in this workspace. */
export async function updateContentDraft(
  context: TenantContext,
  id: string,
  input: BackendContentDraftUpdate
) {
  const draft = await orNull(backendSDK(context).updateContentDraft(id, input))
  return draft ? readDraft(draft) : null
}

/** Delete a draft; false when it is not in this workspace. */
export async function deleteContentDraft(
  context: TenantContext,
  id: string,
  expected?: { version?: number; calendarVersion?: number }
) {
  return (await orNull(backendSDK(context).deleteContentDraft(id, expected))) !== null
}

/** A draft's post with its times as Dates. */
export function readPost(post: BackendContentDraftPost) {
  return {
    ...withDates(post),
    automations: (post.automations ?? []).map((automation) => ({
      ...automation,
      dueAt: new Date(automation.dueAt),
      updatedAt: new Date(automation.updatedAt),
    })),
    scheduledFor: new Date(post.scheduledFor),
  }
}

/** Every post scheduled from a draft; null when it is not in this workspace. */
export async function listContentDraftPosts(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).listContentDraftPosts(id))
  return result ? result.posts.map(readPost) : null
}

/**
 * The channel a connection's draft is built for. dev/social-gate's fake "e2e"
 * destination takes drafts under X's rules, as the backend's
 * PLATFORM_E2E_DRAFT_PLATFORM allows. The gate now runs the production image,
 * like the browser suite, so the gate goes through lib/e2e-hooks.ts: a
 * deployed build still never accepts the fake destination.
 */
function draftChannel(platform: string): DraftChannel | null {
  if (platform !== 'e2e') return channelForPlatform(platform)
  return testHooksAllowed() && process.env.PLATFORM_E2E_DRAFT_PLATFORM === 'enabled' ? 'x' : null
}

/**
 * Schedule the draft to channels, or publish it now. Each destination's
 * payload is built here from the stored draft (its primary body, platform
 * versions, kind and target) with the same function the composer previews
 * with, for the account's own standing; anything that blocks it is refused
 * before anything is queued. The caller sends no text, so the posts carry the
 * stored draft's (F1): the draft read here must not be older than `version`, and Go admits
 * only this server and creates posts only while `version` is current. Go
 * checks its approval, resolves the time and checks every payload again.
 */
export async function prepareContentDraftSchedule(
  context: OrganizationAccess,
  id: string,
  input: {
    blockImages?: (string | null)[]
    channelConnectionIds: string[]
    disambiguation?: 'earlier' | 'later'
    localTime?: string
    naturalTiming?: boolean
    publishNow?: boolean
    /** When set, the set's next free queue slot, reserved by the backend. */
    queue?: boolean
    expectedQueueSlot?: string
    /** Overrides the draft's natural posting time for this schedule. */
    naturalPostingTime?: boolean
    scheduledFor?: Date
    timeZone?: string
    baseCalendarVersion?: number
    version: number
    /** Beside the draft's queued posts instead of replacing them. */
    add?: boolean
    /** Schedule a repeat of an account's post within a day, after the warning. */
    confirmDuplicate?: boolean
  }
) {
  if (!input.publishNow && !input.queue && !input.localTime && !input.scheduledFor) {
    throw new ScheduledPostError('Pick a time, add the draft to the queue, or publish it now.', 400)
  }
  const built = await draftTargets(context, id, input.channelConnectionIds, input.blockImages)
  if (!built) return null
  // Go creates posts only while `version` is current, so text read at an older
  // version must not be sent under it: a later approval would cover that text.
  // A newer read passes, so Go can replay a schedule already made at `version`.
  const read = built[0]?.version
  if (read !== undefined && read < input.version) {
    throw new ScheduledPostError(
      `This draft was saved elsewhere since you opened it; it is now at version ${read}.`,
      409
    )
  }
  const targets = built.map(({ channel, problems, target }) => {
    if (!target) throw new ScheduledPostError('A selected channel cannot take this draft.', 404)
    if (problems.length > 0) throw new ScheduledPostError(`${channel}: ${problems.join(' ')}`, 409)
    return target
  })
  return {
    add: input.add,
    // Only when confirmed: a backend from before the field refuses unknown fields.
    confirmDuplicate: input.confirmDuplicate || undefined,
    expectedQueueSlot: input.expectedQueueSlot,
    disambiguation: input.disambiguation,
    localTime: input.localTime,
    naturalPostingTime: input.naturalPostingTime,
    publishNow: input.publishNow,
    queue: input.queue,
    scheduledFor: input.scheduledFor,
    targets,
    timeZone: input.timeZone,
    baseCalendarVersion: input.baseCalendarVersion,
    version: input.version,
  }
}

/**
 * Each account's payload for the stored draft, or why it cannot take it:
 * the same builder the composer previews with, for the account's standing.
 * Null when the draft is not visible.
 */
export async function draftTargets(
  context: OrganizationAccess,
  id: string,
  channelConnectionIds: string[],
  blockImages?: (string | null)[]
) {
  const draft = await getContentDraft(context, id)
  if (!draft) return null
  const [connections, sets] = await Promise.all([
    listBackendConnections(context),
    backendSDK(context).listSocialSets(),
  ])
  const platforms = new Map(connections.map((connection) => [connection.id, connection.platform]))
  const accounts = new Map(
    sets.items.flatMap((set) => set.accounts.map((account) => [account.id, account] as const))
  )
  const versions = readVersions(
    draft.platformVersions,
    draft.channelText as Partial<Record<DraftChannel, string>>,
    draft.body
  )
  return channelConnectionIds.map((channelConnectionId) => {
    const platform = platforms.get(channelConnectionId)
    const channel = platform ? draftChannel(platform) : null
    if (!channel)
      return {
        channel: platform ?? 'account',
        channelConnectionId,
        problems: ['This account cannot take a draft.'],
        target: null,
        version: draft.version,
      }
    const { problems, target } = buildPublication(
      { ...draft, platformVersions: versions },
      {
        channel,
        connectionId: channelConnectionId,
        standing: {
          tiktokCreator: accounts.get(channelConnectionId)?.tiktokCreator,
          maxWeightedCharacters: accounts.get(channelConnectionId)?.xCaptionLimit,
          articles: accounts.get(channelConnectionId)?.xArticles,
          xQuotes: accounts.get(channelConnectionId)?.xQuotes,
          pollLimits: accounts.get(channelConnectionId)?.pollLimits,
          mastodonQuotes: accounts.get(channelConnectionId)?.mastodonQuotes,
        },
      },
      blockImages
    )
    return { channel, channelConnectionId, problems, target, version: draft.version }
  })
}

/** Schedule using the same preparation as a batch preflight. */
export async function scheduleContentDraft(
  context: OrganizationAccess,
  id: string,
  input: Parameters<typeof prepareContentDraftSchedule>[2]
) {
  const prepared = await prepareContentDraftSchedule(context, id, input)
  if (!prepared) return null
  const result = await backendSDK(context).scheduleContentDraft(id, prepared)
  return {
    created: result.created,
    draft: readDraft(result.draft),
    posts: result.posts.map(readPost),
  }
}

/** Write a post and put it on its accounts: the one way a key or agent posts. */
export async function createPost(
  context: TenantContext,
  input: z.infer<typeof createPostSchema> & { idempotencyKey: string }
) {
  const result = await backendSDK(context).createPost(input)
  return {
    created: result.created,
    draft: readDraft(result.draft),
    posts: result.posts.map(readPost),
    reviewPath: result.reviewPath,
    status: result.status,
  }
}

/** Retry one failed destination; null when it is not visible. */
export async function retryContentDraftPost(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).retryContentDraftPost(id))
  return result ? readPost(result.post) : null
}

/** Settle a post of unknown outcome; null when it is not visible. */
export async function reconcileContentDraftPost(
  context: TenantContext,
  id: string,
  input: { live: boolean; url?: string }
) {
  const result = await orNull(backendSDK(context).reconcileContentDraftPost(id, input))
  return result ? readPost(result.post) : null
}

/** Start deleting a published post from its platform; null when it is not in this workspace. */
export async function deleteContentDraftPost(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).deleteContentDraftPost(id))
  return result ? result.deletion : null
}

/** Stop a live post's pending follow-ups; null when it is not in this workspace. */
export async function cancelContentDraftPostAutomations(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).cancelContentDraftPostAutomations(id))
  return result ? readPost(result.post) : null
}

/** A collaboration token for the draft; null when it is not in this workspace. */
export async function createContentDraftCollabToken(context: OrganizationAccess, id: string) {
  const token = await orNull(backendSDK(context).createContentDraftCollabToken(id))
  return token ? withDates(token) : null
}

/** The workspace's drafts settings: queue slots and approvals. */
export async function getContentDraftSettings(context: TenantContext) {
  return backendSDK(context).getContentDraftSettings()
}

/** Save the drafts settings an owner, admin or publisher sets. */
export async function updateContentDraftSettings(
  context: TenantContext,
  input: {
    postingSlots?: { time: string; weekday: number }[]
    requireApproval?: boolean
    allowSelfApproval?: boolean
  }
) {
  return backendSDK(context).updateContentDraftSettings(input)
}

/** Suggested posting times, from the workspace's engagement. */
export async function bestPostingTimes(context: TenantContext, socialSetId = '') {
  const { items } = await backendSDK(context).bestPostingTimes(socialSetId)
  return items.map((item) => ({ ...item, at: new Date(item.at) }))
}

/** The queue's next free slot. */
export async function nextQueueSlot(context: TenantContext, socialSetId = '') {
  return new Date((await backendSDK(context).nextContentDraftQueueSlot(socialSetId)).scheduledFor)
}

/** Draft posts due in [from, to), with their drafts' titles; one set's when given. */
export async function listContentDraftPostsBetween(
  context: TenantContext,
  from: Date,
  to: Date,
  socialSetId?: string
) {
  const { items } = await backendSDK(context).listContentDraftPostsBetween(from, to, socialSetId)
  return items.map((post) => ({
    ...readPost(post),
    draftId: post.draftId,
    draftTitle: post.draftTitle,
    socialSetId: post.socialSetId,
    version: post.version,
    calendarVersion: post.calendarVersion,
    tagIds: post.tagIds,
  }))
}

/** Move one queued post; null when it is not in this workspace. */
export async function moveContentDraftPost(context: TenantContext, id: string, scheduledFor: Date) {
  const result = await orNull(backendSDK(context).moveContentDraftPost(id, scheduledFor))
  return result ? readPost(result.post) : null
}

/** Swap two immutable queued commitments; the backend enforces visibility and account compatibility. */
export async function swapContentDraftPosts(context: TenantContext, id: string, withId: string) {
  const result = await orNull(backendSDK(context).swapContentDraftPosts(id, withId))
  return result ? result.posts.map(readPost) : null
}

/** Publish one queued snapshot now; null when it is outside this workspace. */
export async function publishQueuedContentDraftPost(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).publishQueuedContentDraftPost(id))
  return result ? readPost(result.post) : null
}

/** Post the rest of a stopped thread; null when the post is not in this workspace. */
export async function resumeContentDraftThread(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).resumeContentDraftThread(id))
  return result ? readPost(result.post) : null
}

/** Read a live post's engagement now; null when it is not in this workspace. */
export async function refreshContentDraftPostMetrics(context: TenantContext, id: string) {
  const post = await orNull(backendSDK(context).refreshContentDraftPostMetrics(id))
  return post ? readPost(post) : null
}

/** A review step on a draft; null when it is not in this workspace. */
export async function reviewContentDraft(
  context: TenantContext,
  id: string,
  input: z.input<typeof reviewContentDraftContract.body>
) {
  const draft = await orNull(backendSDK(context).reviewContentDraft(id, input))
  return draft ? readDraft(draft) : null
}

/** Turn a draft's guest link on or off; null when it is not in this workspace. */
export async function shareContentDraft(context: TenantContext, id: string, enabled: boolean) {
  const draft = await orNull(backendSDK(context).shareContentDraft(id, enabled))
  return draft ? readDraft(draft) : null
}

/** A draft's revisions, newest first; null when it is not in this workspace. */
export async function listContentDraftRevisions(context: TenantContext, id: string) {
  const result = await orNull(backendSDK(context).listContentDraftRevisions(id))
  // A list carries no bodies; one revision's read does.
  return result
    ? result.items.map(
        ({ createdAt, createdByUserId, id: revisionId, plainText, reason, title, version }) => ({
          createdAt: new Date(createdAt),
          createdByUserId,
          id: revisionId,
          plainText,
          reason: revisionReasonSchema.parse(reason ?? 'edit'),
          title,
          version,
        })
      )
    : null
}

/** One revision with its body. */
export async function getContentDraftRevision(
  context: TenantContext,
  id: string,
  revisionId: string
) {
  const revision = await orNull(backendSDK(context).getContentDraftRevision(id, revisionId))
  if (!revision) return null
  const { article, body, platformVersions, reason, ...fields } = revision
  return {
    ...withDates(fields),
    article: article ? articleSchema.parse(article) : undefined,
    body: body as Record<string, unknown>[] | undefined,
    platformVersions: platformVersions ? platformVersionsSchema.parse(platformVersions) : undefined,
    reason: revisionReasonSchema.parse(reason ?? 'edit'),
  }
}

/** A shared draft with Dates, and its body as Plate nodes. */
function readShared(draft: BackendSharedContentDraft) {
  const { body, ...fields } = draft
  return { ...withDates(fields), body: body as Record<string, unknown>[] }
}

/** A guest's view of a shared draft; null for a link that is off or wrong. */
export async function getSharedContentDraft(token: string) {
  const draft = await orNull(serviceBackend().getSharedContentDraft(token))
  return draft ? readShared(draft) : null
}

/** Keep a guest's comment on a shared draft; null for a link that is off. */
export async function addGuestComment(token: string, input: { name: string; text: string }) {
  const draft = await orNull(serviceBackend().addGuestComment(token, input))
  return draft ? readShared(draft) : null
}

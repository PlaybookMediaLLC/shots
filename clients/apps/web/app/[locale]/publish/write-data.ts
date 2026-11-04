import 'server-only'

import { contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { libraryDraft } from '@/lib/write/library'
import { cookies } from 'next/headers'
import { z } from 'zod'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import { listContentDraftPostsBetween, listContentDrafts } from '@/lib/tenant/content-drafts'
import { listDraftTags, listPlannedContentDrafts, listSocialSets } from '@/lib/tenant/write'
import { draftKindSchema } from '@/lib/write/document'
import { contentDraftSortSchema } from '@/lib/write/wire'
import { postState } from '@/lib/content-drafts/post-status'
import { draftPlainText } from '@/lib/content-drafts/serialize'
import { draftVocabulary } from '@/lib/content-drafts/vocabulary'
import { SOCIAL_SET_COOKIE } from '@/lib/settings/appearance'

/**
 * What every Write page loads (RFC 025): the social sets the member may see,
 * the active one, its draft library for the chosen lifecycle tab, filters
 * and order, its queue, and its tags. The active set comes from the URL,
 * then the last one chosen (a cookie), then the workspace's default set.
 */

/** The library tabs: drafts being written, the queue, what went live, the archive. */
export const writeTabSchema = z.enum(['drafts', 'queue', 'posted', 'archived'])

/** One of {@link writeTabSchema}. */
export type WriteTab = z.infer<typeof writeTabSchema>

/** The library's URL state. */
export const writeQuerySchema = z.object({
  kind: draftKindSchema.optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  set: z.string().max(40).optional().catch(undefined),
  sort: contentDraftSortSchema.optional().catch(undefined),
  tab: writeTabSchema.optional().catch(undefined),
  tag: z.string().max(40).optional().catch(undefined),
})

/** One of {@link writeQuerySchema}. */
export type WriteQuery = z.infer<typeof writeQuerySchema>

/**
 * The settings platform's experiments Write follows (RFC 024): tags on drafts.
 * The backend refuses them unless the person turned them on and the workspace
 * allows them. Planning was promoted and is always on.
 */
export const writeExperimentSchema = z.enum(['draft-tags'])

/**
 * Load the library for a Write page. The query may still be resolving (a draft
 * page learns its set from the draft), so the first reads start without it.
 */
export async function loadWrite(
  tenant: OrganizationAccess,
  rawQuery: Record<string, unknown> | Promise<Record<string, unknown>>
) {
  const remembered = (await cookies()).get(SOCIAL_SET_COOKIE)?.value
  const queried = Promise.resolve(rawQuery).then((raw) => writeQuerySchema.parse(raw))
  const now = new Date()
  const horizon = new Date(now.getTime() + 60 * 86_400_000)
  // Overdue and unconfirmed posts stay in the queue after their time passes.
  const since = new Date(now.getTime() - 2 * 86_400_000)
  const readLibrary = (query: WriteQuery, setId: string | undefined, tags: boolean) =>
    Promise.all([
      listContentDrafts(tenant, {
        kind: query.kind,
        limit: 100,
        socialSetId: setId,
        sort: query.sort,
        tagId: tags ? query.tag : undefined,
        view: query.tab === 'queue' || !query.tab ? 'drafts' : query.tab,
      }),
      listContentDraftPostsBetween(tenant, since, horizon, setId),
      listPlannedContentDrafts(tenant, now, horizon, setId),
    ])
  // The set is nearly always the URL's or the remembered one, so its library is
  // read alongside the set list rather than after it. A wrong guess (or a tag
  // filter, which waits for the experiment flag) is read again below.
  const guessed = queried.then(async (query) => {
    const setId = query.set ?? remembered
    if (!setId || query.tag) return null
    const library = await readLibrary(query, setId, false).catch(() => null)
    return library && { library, setId }
  })
  const [sets, experimentList, advanced, query, early] = await Promise.all([
    listSocialSets(tenant),
    orNull(backendSDK(tenant).listExperiments()),
    backendSDK(tenant).getFeatureDecision('content:scheduling-advanced'),
    queried,
    guessed,
  ])
  const enabled = (id: z.infer<typeof writeExperimentSchema>) =>
    experimentList?.items.some((item) => item.id === id && item.enabled) ?? false
  const experiments = { tags: enabled('draft-tags') }
  const activeSet =
    sets.find((set) => set.id === query.set) ??
    sets.find((set) => set.id === remembered) ??
    sets.find((set) => set.visibility === 'WORKSPACE') ??
    sets[0]
  const tab: WriteTab = query.tab ?? 'drafts'
  const [[page, posts, planned], tags] = await Promise.all([
    early && early.setId === activeSet?.id
      ? early.library
      : readLibrary(query, activeSet?.id, experiments.tags),
    activeSet && experiments.tags ? listDraftTags(tenant, activeSet.id) : Promise.resolve([]),
  ])
  const library = [...page.pinned, ...page.items].map((draft) =>
    libraryDraft(contentDraftSchema.parse(draft))
  )
  const queue = [
    // Posts that still hold their slot, including one that may already be live.
    ...posts
      .filter((post) => ['SCHEDULED', 'PROCESSING', 'UNKNOWN_DELIVERY'].includes(post.status))
      .map((post) => ({
        at: post.scheduledFor.toISOString(),
        caption: post.caption,
        draftId: post.draftId,
        id: post.id,
        kind: 'scheduled' as const,
        platform: post.platform,
        state: postState(post.status, post.scheduledFor, now.getTime()),
      })),
    ...planned.map((draft) => ({
      at: draft.plannedFor?.toISOString() ?? now.toISOString(),
      caption: (draft.plainText || draftPlainText(draft.body)).slice(0, 180),
      draftId: draft.id,
      id: `planned-${draft.id}`,
      kind: 'planned' as const,
      platform: draft.primaryPlatform,
      state: null,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at))
  return {
    activeSet: activeSet ?? null,
    advancedScheduling: advanced.allowed,
    experiments,
    library,
    hasMore: page.nextCursor !== null,
    query: { ...query, tab },
    queue,
    sets,
    tags: (tags ?? []).map((tag) => ({ ...tag, createdAt: tag.createdAt.toISOString() })),
    vocabulary: draftVocabulary(page.items.map((draft) => draft.plainText)),
  }
}

/** The library as the Write pages hand it to the browser. */
export type WriteData = Awaited<ReturnType<typeof loadWrite>>

import 'server-only'

import { giphyEnabled } from '@/lib/content-drafts/giphy'
import { googleDriveConfig } from '@/lib/content-drafts/google-drive'
import { contentDraftPostSchema, contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { accessAllows } from '@/lib/auth/permissions'
import {
  createContentDraftCollabToken,
  getContentDraft,
  getContentDraftSettings,
  listContentDraftPosts,
} from '@/lib/tenant/content-drafts'
import { aiAllowed } from '@/lib/trpc/routers/launch'
import { requireDraftsPageAccess } from '../../drafts/page-access'
import { loadWrite } from '../write-data'

/**
 * Everything the composer opens a draft with: the draft, its posts, the
 * library of its set, the workspace's approval rule, a first collaboration
 * token, and what this member may do.
 *
 * One loader for both places the composer opens, so they can never differ:
 * the Publish page (`/publish/<id>`) and the publishing workspace the
 * screenshot editor opens over itself for the same address.
 * Null when the draft is not in this workspace.
 */
export async function loadDraftComposer(
  locale: string,
  draftId: string,
  query: Record<string, string | undefined>
) {
  const access = await requireDraftsPageAccess(locale, `/publish/${draftId}`)
  // Real-time co-editing runs when the collaboration server is configured.
  const collabUrl = process.env.PLATFORM_COLLAB_URL || null
  // Every read starts at once; only the library's draft list waits for the draft's set.
  const loadingDraft = getContentDraft(access.tenant, draftId)
  const [draft, data, posts, settings, collabToken] = await Promise.all([
    loadingDraft,
    // The library shows the set the draft belongs to, whatever was open before.
    loadWrite(
      access.tenant,
      loadingDraft.then((loaded) => ({ ...query, set: loaded?.socialSetId ?? undefined })),
      access.hasAdvancedScheduling
    ),
    listContentDraftPosts(access.tenant, draftId),
    getContentDraftSettings(access.tenant),
    // Issued with the page, so the editor connects without waiting for another request.
    collabUrl ? createContentDraftCollabToken(access.tenant, draftId).catch(() => null) : null,
  ])
  if (!draft) return null
  return {
    access: {
      campaignsEnabled: access.campaignWorkflowEnabled,
      campaignsUsable: access.campaignWorkflowEnabled && access.hasPaidPlan,
      canEdit: accessAllows(access, 'artifact:edit'),
      canManageSets: accessAllows(access, 'workspace:update'),
      canPublish: accessAllows(access, 'publish:manage'),
      canReview: accessAllows(access, 'release:approve'),
      organizationName: access.organization.name,
    },
    composer: {
      // The page access already read the plan and the workspace settings.
      aiEnabled: aiAllowed(access.hasPaidPlan, access.organization.workspaceSettings),
      collabToken,
      collabUrl,
      draft: contentDraftSchema.parse(draft),
      drive: googleDriveConfig(),
      giphy: giphyEnabled(),
      posts: (posts ?? []).map((post) => contentDraftPostSchema.parse(post)),
      requireApproval: settings.requireApproval,
      set: data.activeSet,
      user: { id: access.session.user.id, name: access.session.user.name },
      vocabulary: data.vocabulary,
    },
    data,
  }
}

import { giphyEnabled } from '@/lib/content-drafts/giphy'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { WriteComposer } from '@/components/write/composer/WriteComposer'
import { WriteFrame } from '@/components/write/WriteFrame'
import { contentDraftPostSchema, contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { accessAllows } from '@/lib/auth/permissions'
import {
  createContentDraftCollabToken,
  getContentDraft,
  getContentDraftSettings,
  listContentDraftPosts,
} from '@/lib/tenant/content-drafts'
import { isAiEnabled } from '@/lib/trpc/routers/launch'
import { requireDraftsPageAccess } from '../../drafts/page-access'
import { loadWrite } from '../write-data'

export const metadata: Metadata = { title: 'Draft · Publish' }

type WriteDraftPageProps = {
  params: Promise<{ draftId: string; locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

/** Write with a draft open: the library of the draft's set beside the composer. */
export default async function WriteDraftPage({ params, searchParams }: WriteDraftPageProps) {
  const { draftId, locale } = await params
  const access = await requireDraftsPageAccess(locale, `/publish/${draftId}`)
  const canManageSets = accessAllows(access, 'workspace:update')
  // Real-time co-editing runs when the collaboration server is configured.
  const collabUrl = process.env.PLATFORM_COLLAB_URL || null
  // Every read starts at once; only the library's draft list waits for the draft's set.
  const loadingDraft = getContentDraft(access.tenant, draftId)
  const query = await searchParams
  const [draft, data, posts, aiEnabled, settings, collabToken] = await Promise.all([
    loadingDraft,
    // The library shows the set the draft belongs to, whatever was open before.
    loadWrite(
      access.tenant,
      loadingDraft.then((loaded) => ({ ...query, set: loaded?.socialSetId ?? undefined }))
    ),
    listContentDraftPosts(access.tenant, draftId),
    isAiEnabled(access.tenant).catch(() => false),
    getContentDraftSettings(access.tenant),
    // Issued with the page, so the editor connects without waiting for another request.
    collabUrl ? createContentDraftCollabToken(access.tenant, draftId).catch(() => null) : null,
  ])
  if (!draft) notFound()
  const canEdit = accessAllows(access, 'artifact:edit')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <WriteFrame
        campaignsEnabled={access.campaignWorkflowEnabled && access.hasPaidPlan}
        activeId={draft.id}
        canEdit={canEdit}
        canManageSets={canManageSets}
        canPublish={accessAllows(access, 'publish:manage')}
        canReview={accessAllows(access, 'release:approve')}
        data={data}
      >
        <WriteComposer
          aiEnabled={aiEnabled}
          collabToken={collabToken}
          collabUrl={collabUrl}
          draft={contentDraftSchema.parse(draft)}
          giphy={giphyEnabled()}
          key={draft.id}
          posts={(posts ?? []).map((post) => contentDraftPostSchema.parse(post))}
          requireApproval={settings.requireApproval}
          set={data.activeSet}
          user={{ id: access.session.user.id, name: access.session.user.name }}
          vocabulary={data.vocabulary}
        />
      </WriteFrame>
    </PlatformShell>
  )
}

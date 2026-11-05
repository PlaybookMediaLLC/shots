import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { AnalyzeNav } from '@/components/plan/WorkspaceNav'
import { WriteFrame } from '@/components/write/WriteFrame'
import { PostingTimes } from '@/components/write/PostingTimes'
import { calendarPostSchema } from '@/lib/api/contracts/content-draft-platform'
import { accessAllows } from '@/lib/auth/permissions'
import { listContentDraftPostsBetween } from '@/lib/tenant/content-drafts'
import { requireDraftsPageAccess } from '../../../drafts/page-access'
import { loadWrite } from '../../write-data'

export const metadata = { title: 'Posting times · Analyze · Publish' }

/** Analyze engagement in the selected social set, retaining Write and Plan context. */
export default async function PostingTimesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { locale } = await params
  const access = await requireDraftsPageAccess(locale, '/publish/analyze/posting-times')
  const data = await loadWrite(access.tenant, await searchParams)
  const set = data.activeSet
  const now = new Date()
  const posts = set
    ? await listContentDraftPostsBetween(
        access.tenant,
        new Date(now.getTime() - 90 * 86_400_000),
        now,
        set.id
      )
    : []
  const canManage = accessAllows(access, 'workspace:update')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <WriteFrame
        activeId="analyze"
        section="analyze"
        campaignsEnabled={access.campaignWorkflowEnabled && access.hasPaidPlan}
        canEdit={accessAllows(access, 'artifact:edit')}
        canManageSets={canManage}
        canPublish={accessAllows(access, 'publish:manage')}
        canReview={accessAllows(access, 'release:approve')}
        data={data}
      >
        <AnalyzeNav active="Best times and posting slots" scope={set ? `?set=${set.id}` : ''} />
        {set ? (
          <PostingTimes
            key={set.id}
            canEdit={canManage}
            initialSet={{
              id: set.id,
              name: set.name,
              version: set.version,
              timeZone: set.timeZone,
              postingSlots: set.postingSlots,
            }}
            posts={posts.map((post) => calendarPostSchema.parse(post))}
          />
        ) : (
          <p className="p-6">Connect a publishing brand to see its posting times.</p>
        )}
      </WriteFrame>
    </PlatformShell>
  )
}

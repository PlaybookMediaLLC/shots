import type { Metadata } from 'next'
import { PlanWorkspace } from '@/components/plan/PlanWorkspace'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { socialSetSchema } from '@/lib/api/contracts/social-sets'
import { accessAllows } from '@/lib/auth/permissions'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import { listSocialSets } from '@/lib/tenant/write'
import { requireDraftsPageAccess } from '../../drafts/page-access'

export const metadata: Metadata = { title: 'Calendar · Publish' }

/** Personal calendar visibility is independent of the active Write social set. */
export default async function WritePlanPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { locale } = await params
  const query = await searchParams
  const access = await requireDraftsPageAccess(locale, '/publish/calendar')
  const [sets, preferences] = await Promise.all([
    listSocialSets(access.tenant),
    orNull(backendSDK(access.tenant).getUserPreferences()),
  ])
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <div className="h-[calc(100dvh-4rem)] min-h-[480px]">
        <PlanWorkspace
          sets={sets.map((s) => socialSetSchema.parse(s))}
          canEdit={accessAllows(access, 'artifact:edit')}
          canManageSets={accessAllows(access, 'workspace:update')}
          canPublish={accessAllows(access, 'publish:manage')}
          preferenceKey={`shots:plan:${access.organization.id}:${access.session.user.id}`}
          initialZone={sets[0]?.timeZone ?? 'UTC'}
          initialWeekStart={preferences?.weekStart === 'sunday' ? 0 : 1}
          initialDay={query.day ?? query.week}
          initialView={query.view}
          advancedScheduling={access.hasAdvancedScheduling}
        />
      </div>
    </PlatformShell>
  )
}

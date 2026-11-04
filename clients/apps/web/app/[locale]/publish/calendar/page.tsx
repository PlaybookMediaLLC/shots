import type { Metadata } from 'next'
import { PlanWorkspace } from '@/components/plan/PlanWorkspace'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { socialSetSchema } from '@/lib/api/contracts/social-sets'
import { hasPermission } from '@/lib/auth/permissions'
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
  const [sets, preferences, advanced] = await Promise.all([
    listSocialSets(access.tenant),
    orNull(backendSDK(access.tenant).getUserPreferences()),
    backendSDK(access.tenant).getFeatureDecision('content:scheduling-advanced'),
  ])
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <div className="h-[calc(100dvh-4rem)] min-h-[480px]">
        <PlanWorkspace
          sets={sets.map((s) => socialSetSchema.parse(s))}
          canEdit={hasPermission(access.role, 'artifact:edit')}
          canManageSets={hasPermission(access.role, 'workspace:update')}
          canPublish={hasPermission(access.role, 'publish:manage')}
          preferenceKey={`shots:plan:${access.organization.id}:${access.session.user.id}`}
          initialZone={sets[0]?.timeZone ?? 'UTC'}
          initialWeekStart={preferences?.weekStart === 'sunday' ? 0 : 1}
          initialDay={query.day ?? query.week}
          initialView={query.view}
          advancedScheduling={advanced.allowed}
        />
      </div>
    </PlatformShell>
  )
}

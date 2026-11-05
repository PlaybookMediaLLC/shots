import type { Metadata } from 'next'
import { AnalyzeWorkspace } from '@/components/analyze/AnalyzeWorkspace'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { socialSetSchema } from '@/lib/api/contracts/social-sets'
import { accessAllows } from '@/lib/auth/permissions'
import { listSocialSets } from '@/lib/tenant/write'
import { requireDraftsPageAccess } from '../../drafts/page-access'

export const metadata: Metadata = { title: 'Analyze · Publish' }

export default async function AnalyzePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { locale } = await params
  const access = await requireDraftsPageAccess(locale, '/publish/analyze')
  const sets = await listSocialSets(access.tenant)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <AnalyzeWorkspace
        sets={sets.map((s) => socialSetSchema.parse(s))}
        canManage={accessAllows(access, 'publish:manage')}
        initial={await searchParams}
      />
    </PlatformShell>
  )
}

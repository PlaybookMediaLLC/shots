import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { CodeStudio } from '@/components/code-studio/CodeStudio'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { hasPermission } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

export const metadata = { title: 'Code Studio' }

/** A new Code Studio project (RFC 053); it stays in this browser until saved. */
export default async function NewCodeProjectPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const access = await requirePaidPageAccess(await headers(), locale, '/create/code')
  const canEdit = hasPermission(access.role, 'artifact:edit')
  return (
    <PlatformShell
      variant="editor"
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <CodeStudio
        workspaceId={access.organization!.id}
        canEdit={canEdit}
        canStartPost={canEdit && contentDraftsEnabled() && access.hasBasicScheduling}
      />
    </PlatformShell>
  )
}

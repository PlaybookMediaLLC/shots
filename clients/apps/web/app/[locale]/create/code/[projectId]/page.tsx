import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { CodeStudio } from '@/components/code-studio/CodeStudio'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

export const metadata = { title: 'Code Studio' }

/** A saved Code Studio project (RFC 053). */
export default async function CodeProjectPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>
}) {
  const { locale, projectId } = await params
  const access = await requirePaidPageAccess(await headers(), locale, `/create/code/${projectId}`)
  const canEdit = accessAllows(access, 'artifact:edit')
  return (
    <PlatformShell
      variant="editor"
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <CodeStudio
        projectId={projectId}
        workspaceId={access.organization!.id}
        canEdit={canEdit}
        canStartPost={canEdit && contentDraftsEnabled() && access.hasBasicScheduling}
      />
    </PlatformShell>
  )
}

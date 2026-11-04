import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { StorySetEditor } from '@/components/creative-sets/StorySetEditor'

export const metadata: Metadata = { title: 'Story Set' }

export default async function StorySetPage({
  params,
}: {
  params: Promise<{ locale: string; setId: string }>
}) {
  const { locale, setId } = await params
  const access = await requirePaidPageAccess(await headers(), locale, `/creative-sets/${setId}`)
  return (
    <PlatformShell
      variant="editor"
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <StorySetEditor
        key={setId}
        setId={setId}
        collabUrl={process.env.PLATFORM_COLLAB_URL || null}
        user={{ id: access.session.user.id, name: access.session.user.name }}
        workspaceId={access.organization!.id}
        canEdit={accessAllows(access, 'artifact:edit')}
        canCreate={access.creativeSetsEnabled}
      />
    </PlatformShell>
  )
}

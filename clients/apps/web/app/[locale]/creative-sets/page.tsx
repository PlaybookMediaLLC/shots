import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { StorySetLibrary } from '@/components/creative-sets/StorySetLibrary'

export const metadata: Metadata = { title: 'Story Sets' }

export default async function StorySetsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const access = await requirePaidPageAccess(await headers(), locale, '/creative-sets')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <StorySetLibrary
        canCreate={access.creativeSetsEnabled}
        canEdit={accessAllows(access, 'artifact:edit')}
      />
    </PlatformShell>
  )
}

import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { VoiceInbox } from '@/components/voice/VoiceInbox'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

export const metadata: Metadata = { title: 'Voice notes · Create' }

/** The member's own voice notes from the Shots app (docs/plans/voice-capture-and-evidence-plan.md 5.2). */
export default async function VoiceNotesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const access = await requirePaidPageAccess(await headers(), locale, '/create/voice')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page
        title="Voice notes"
        description="Notes you recorded in the Shots app. Only you can see them, until you make a draft from one."
      >
        <VoiceInbox
          canDraft={
            contentDraftsEnabled() &&
            access.hasBasicScheduling &&
            accessAllows(access, 'artifact:edit')
          }
        />
      </Page>
    </PlatformShell>
  )
}

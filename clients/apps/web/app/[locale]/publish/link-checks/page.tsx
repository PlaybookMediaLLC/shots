import { ReturnToWork } from '@/components/platform-hub/ReturnToWork'
import { WorkspaceNav } from '@/components/plan/WorkspaceNav'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { LinkPreviewApp } from '@/components/link-preview/LinkPreviewApp'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'

export const metadata: Metadata = { title: 'Link checks · Publish', robots: { index: false } }

type LinkPreviewPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ set?: string | string[] }>
}

export default async function LinkPreviewPage({ params, searchParams }: LinkPreviewPageProps) {
  const [{ locale }, query, requestHeaders] = await Promise.all([params, searchParams, headers()])
  // The Publish tabs keep the publishing brand.
  const set = typeof query.set === 'string' && /^[\w-]+$/.test(query.set) ? query.set : null
  const scope = set ? `?set=${set}` : ''
  const access = await getPageAccess(requestHeaders)
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  if (!access.hasOrganization || !access.organization) {
    redirect(getLocalizedPath(locale, '/onboarding'))
  }
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))

  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      {contentDraftsEnabled() ? (
        <WorkspaceNav active="links" scope={scope} />
      ) : null}
      <Page
        description="See how a link unfurls on 13 platforms, fix what breaks it, make its preview image, and share it with tracked links."
        title="Link checks"
      >
        <ReturnToWork />
        <LinkPreviewApp />
      </Page>
    </PlatformShell>
  )
}

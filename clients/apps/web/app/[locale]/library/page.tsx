import { LIBRARY_LINKS } from '@/lib/platform/navigation'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { BrandAssets } from '@/components/platform-hub/BrandAssets'
import { LocalStoreProjects } from '@/components/platform-hub/LocalStoreProjects'
import { ProjectLibrary } from '@/components/projects/ProjectLibrary'
import { CanvasLibrary } from '@/components/canvas-workspace/CanvasLibrary'
import { StorySetLibrary } from '@/components/creative-sets/StorySetLibrary'
import { WorkspaceAssets } from '@/components/workspace/WorkspaceAssets'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { hasPermission } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

type LibraryPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ type?: string; view?: string }>
}

/** The tab title names the Library page shown, as the sidebar does. */
export async function generateMetadata({ searchParams }: LibraryPageProps): Promise<Metadata> {
  const { type, view } = await searchParams
  const href = view ? `/library?view=${view}` : type ? `/library?type=${type}` : '/library'
  const page = LIBRARY_LINKS.find((link) => link.href === href)?.label ?? 'Screenshots'
  return { title: `${page} · Library` }
}

export default async function LibraryPage({ params, searchParams }: LibraryPageProps) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const access = await requirePaidPageAccess(await headers(), locale, '/library')
  const canEdit = hasPermission(access.role, 'artifact:edit')
  const view = ['assets', 'brand'].includes(query.view ?? '') ? query.view : 'projects'
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page title="Library" description="Everything your team has made.">
        <AreaNavigation label="Library" items={LIBRARY_LINKS} />
        {view === 'assets' ? (
          <WorkspaceAssets canStartPost={canEdit && contentDraftsEnabled()} />
        ) : view === 'brand' ? (
          <BrandAssets />
        ) : (
          <>
            {query.type === 'canvas' ? (
              <CanvasLibrary
                embedded
                canEdit={canEdit}
                storySetsEnabled={access.creativeSetsEnabled}
                campaignsEnabled={access.campaignWorkflowEnabled}
              />
            ) : query.type === 'story' ? (
              <StorySetLibrary embedded canEdit={canEdit} canCreate={access.creativeSetsEnabled} />
            ) : query.type === 'store' ? (
              <LocalStoreProjects canEdit={canEdit} />
            ) : (
              <div className="grid gap-4">
                <p className="text-sm text-muted-foreground">
                  Screenshot projects · Saved to workspace
                </p>
                <ProjectLibrary canEdit={canEdit} />
              </div>
            )}
          </>
        )}
      </Page>
    </PlatformShell>
  )
}

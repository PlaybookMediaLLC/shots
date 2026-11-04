import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation, LIBRARY_LINKS } from '@/components/platform-hub/AreaNavigation'
import { ResourceCards, BRAND_RESOURCES } from '@/components/platform-hub/ResourceCards'
import { TemplateBrowser } from '@/components/platform-hub/TemplateBrowser'
import { LocalStoreProjects } from '@/components/platform-hub/LocalStoreProjects'
import { ProjectLibrary } from '@/components/projects/ProjectLibrary'
import { CanvasLibrary } from '@/components/canvas-workspace/CanvasLibrary'
import { StorySetLibrary } from '@/components/creative-sets/StorySetLibrary'
import { WorkspaceAssets } from '@/components/workspace/WorkspaceAssets'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { hasPermission } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

export const metadata = { title: 'Library' }
export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ type?: string; view?: string }>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const access = await requirePaidPageAccess(await headers(), locale, '/library')
  const canEdit = hasPermission(access.role, 'artifact:edit')
  const view = ['assets', 'templates', 'brand'].includes(query.view ?? '') ? query.view : 'projects'
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page title="Library" description="Everything your team has made.">
        <AreaNavigation label="Library" items={LIBRARY_LINKS} />
        {view === 'assets' ? (
          <WorkspaceAssets canStartPost={canEdit && contentDraftsEnabled()} />
        ) : view === 'templates' ? (
          <TemplateBrowser />
        ) : view === 'brand' ? (
          <ResourceCards items={BRAND_RESOURCES} />
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

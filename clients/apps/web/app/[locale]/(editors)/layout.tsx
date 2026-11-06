import { headers } from 'next/headers'
import type { ReactNode } from 'react'
import { EditorWorkspace } from '@/components/platform-shell/EditorWorkspace'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { getPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { CanStartPostProvider } from '@/lib/platform/can-start-post'

/**
 * The screenshot editor (`/`) and the store studio (`/create/store`) share this
 * layout, so moving between them keeps both documents, selections and undo
 * histories mounted. Each page checks access and redirects whoever may not
 * open it; the editors render only for a workspace that may.
 */
export default async function EditorsLayout({ children }: { children: ReactNode }) {
  const access = await getPageAccess(await headers())
  return (
    <>
      {children}
      {access?.hasOrganization && access.isWorkspaceOperational && access.hasPaidPlan ? (
        <PlatformShell
          campaignsEnabled={access.campaignWorkflowEnabled}
          organizationName={access.organization?.name}
          variant="editor"
        >
          <ErrorBoundary>
            <CanStartPostProvider
              value={accessAllows(access, 'artifact:edit') && contentDraftsEnabled()}
            >
              <EditorWorkspace />
            </CanStartPostProvider>
          </ErrorBoundary>
        </PlatformShell>
      ) : null}
    </>
  )
}

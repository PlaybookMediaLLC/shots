import { headers } from 'next/headers'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { CanvasEditor } from '@/components/canvas-workspace/CanvasEditor'

export default async function CanvasWorkspacePage({
  params,
}: {
  params: Promise<{ locale: string; canvasId: string }>
}) {
  const { locale, canvasId } = await params
  const access = await requirePaidPageAccess(await headers(), locale, `/canvas/${canvasId}`)
  return (
    <PlatformShell
      variant="editor"
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <CanvasEditor
        canvasId={canvasId}
        workspaceId={access.organization!.id}
        canEdit={accessAllows(access, 'artifact:edit')}
        canHandOff={access.campaignWorkflowEnabled && accessAllows(access, 'release:create')}
        collabUrl={process.env.PLATFORM_COLLAB_URL || null}
        user={{ id: access.session.user.id, name: access.session.user.name }}
      />
    </PlatformShell>
  )
}

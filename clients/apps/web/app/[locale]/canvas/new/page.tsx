import { headers } from 'next/headers'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { NewCanvas } from '@/components/canvas-workspace/NewCanvas'

export const metadata = { title: 'New canvas' }

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export default async function NewCanvasPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  const query = await searchParams
  const access = await requirePaidPageAccess(await headers(), locale, '/canvas/new')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <NewCanvas
        canEdit={accessAllows(access, 'artifact:edit')}
        campaignsEnabled={access.campaignWorkflowEnabled}
        source={{
          start: one(query.start),
          recipe: one(query.recipe),
          project: one(query.project),
          set: one(query.set),
          design: one(query.design),
          blank: one(query.blank) === '1',
        }}
      />
    </PlatformShell>
  )
}

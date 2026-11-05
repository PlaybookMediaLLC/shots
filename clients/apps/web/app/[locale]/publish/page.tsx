import type { Metadata } from 'next'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { ImportDraft } from '@/components/write/import-draft'
import { NewDraftMenu } from '@/components/write/library'
import { WriteFrame } from '@/components/write/WriteFrame'
import { accessAllows } from '@/lib/auth/permissions'
import { requireDraftsPageAccess } from '../drafts/page-access'
import { loadWrite } from './write-data'

export const metadata: Metadata = { title: 'Drafts · Publish' }

type WritePageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

/** Write: the social set's library, with nothing open yet. */
export default async function WritePage({ params, searchParams }: WritePageProps) {
  const { locale } = await params
  const query = await searchParams
  const returnParams = new URLSearchParams(
    Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
  const access = await requireDraftsPageAccess(
    locale,
    `/publish${returnParams.size ? `?${returnParams}` : ''}`
  )
  const canManageSets = accessAllows(access, 'workspace:update')
  const data = await loadWrite(access.tenant, query)
  const canEdit = accessAllows(access, 'artifact:edit')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <WriteFrame
        campaignsEnabled={access.campaignWorkflowEnabled && access.hasPaidPlan}
        canEdit={canEdit}
        canManageSets={canManageSets}
        canPublish={accessAllows(access, 'publish:manage')}
        canReview={accessAllows(access, 'release:approve')}
        data={data}
      >
        {canEdit && typeof query.new === 'string' ? (
          <ImportDraft text={query.new} socialSetId={data.activeSet?.id} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              <p className="text-sm text-foreground">
                Write it once, adapt it per platform, publish when it is right.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Open a draft on the left, or start a new one in{' '}
                {data.activeSet?.name ?? 'this profile'}.
              </p>
              {canEdit ? (
                <div className="mt-4 flex justify-center">
                  <NewDraftMenu compact />
                </div>
              ) : null}
            </div>
          </div>
        )}
      </WriteFrame>
    </PlatformShell>
  )
}

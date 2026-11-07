import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { WriteComposer } from '@/components/write/composer/WriteComposer'
import { WriteFrame } from '@/components/write/WriteFrame'
import { loadDraftComposer } from './composer-data'

export const metadata: Metadata = { title: 'Draft · Publish' }

type WriteDraftPageProps = {
  params: Promise<{ draftId: string; locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

/** Write with a draft open: the library of the draft's set beside the composer. */
export default async function WriteDraftPage({ params, searchParams }: WriteDraftPageProps) {
  const { draftId, locale } = await params
  const loaded = await loadDraftComposer(locale, draftId, await searchParams)
  if (!loaded) notFound()
  const { access, composer, data } = loaded
  return (
    <PlatformShell
      campaignsEnabled={access.campaignsEnabled}
      organizationName={access.organizationName}
    >
      <WriteFrame
        campaignsEnabled={access.campaignsUsable}
        activeId={composer.draft.id}
        canEdit={access.canEdit}
        canManageSets={access.canManageSets}
        canPublish={access.canPublish}
        canReview={access.canReview}
        data={data}
      >
        <WriteComposer {...composer} key={composer.draft.id} />
      </WriteFrame>
    </PlatformShell>
  )
}

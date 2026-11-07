import { notFound } from 'next/navigation'
import { WriteComposer } from '@/components/write/composer/WriteComposer'
import { PublishWorkspace } from '@/components/write/PublishWorkspace'
import { loadDraftComposer } from '../../../../../publish/[draftId]/composer-data'

type PublishWorkspacePageProps = {
  params: Promise<{ draftId: string; locale: string }>
  searchParams: Promise<Record<string, string | undefined>>
}

/**
 * A draft opened from the screenshot editor: the Publish page's own composer,
 * loaded the same way (`loadDraftComposer`), shown as a workspace over the
 * editor instead of replacing it. Only a navigation from the editor lands
 * here (see `../../layout.tsx`); the same address opened directly, or from
 * anywhere else, is the full Publish page.
 */
export default async function PublishWorkspacePage({
  params,
  searchParams,
}: PublishWorkspacePageProps) {
  const { draftId, locale } = await params
  const loaded = await loadDraftComposer(locale, draftId, await searchParams)
  if (!loaded) notFound()
  const { access, composer, data } = loaded
  return (
    <PublishWorkspace
      activeId={composer.draft.id}
      canEdit={access.canEdit}
      canManageSets={access.canManageSets}
      canPublish={access.canPublish}
      canReview={access.canReview}
      data={data}
    >
      <WriteComposer {...composer} key={composer.draft.id} layout="workspace" />
    </PublishWorkspace>
  )
}

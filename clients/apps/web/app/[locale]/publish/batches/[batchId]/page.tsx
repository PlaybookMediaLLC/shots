import { notFound } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { BatchWorkspace } from '@/components/write/batch/BatchWorkspace'
import { contentBatchSchema } from '@/lib/api/contracts/content-batches'
import { accessAllows } from '@/lib/auth/permissions'
import { getContentBatch } from '@/lib/tenant/content-batches'
import { listSocialSets } from '@/lib/tenant/write'
import { captionLimit } from '@/lib/write/capabilities'
import { requireDraftsPageAccess } from '../../../drafts/page-access'

export const metadata = { title: 'Bulk batch · Publish' }

/** One batch: its items, uploads, checks and results, reopened from the backend. */
export default async function BatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; batchId: string }>
  searchParams: Promise<{ start?: string }>
}) {
  const [{ locale, batchId }, query] = await Promise.all([params, searchParams])
  const access = await requireDraftsPageAccess(
    locale,
    `/publish/batches/${encodeURIComponent(batchId)}`
  )
  const [batch, sets] = await Promise.all([
    getContentBatch(access.tenant, batchId),
    listSocialSets(access.tenant),
  ])
  if (!batch) notFound()
  const set = sets.find((candidate) => candidate.id === batch.socialSetId)
  const accounts = (set?.accounts ?? []).map((account) => ({
    captionLimit: captionLimit(account.channel, { maxWeightedCharacters: account.xCaptionLimit }),
    tiktokCreator: account.tiktokCreator,
    channel: account.channel,
    displayName: account.displayName,
    handle: account.handle,
    id: account.id,
    name: account.handle
      ? `${account.handle} (${account.channel})`
      : (account.displayName ?? account.channel),
  }))
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <BatchWorkspace
        accounts={accounts}
        canPublish={accessAllows(access, 'publish:manage')}
        defaults={
          set
            ? { defaultPlatforms: set.defaultPlatforms, primaryPlatform: set.primaryPlatform }
            : undefined
        }
        initial={contentBatchSchema.parse(batch)}
        start={
          query.start === 'videos' ||
          query.start === 'images' ||
          query.start === 'grid' ||
          query.start === 'text'
            ? query.start
            : undefined
        }
      />
    </PlatformShell>
  )
}

import Link from 'next/link'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { EmptyState, Group, Page, Pill, Row, Section } from '@/components/platform-ui'
import { LibraryIcon } from '@/components/platform-shell/icons'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { NewBatchButton } from '@/components/write/batch/NewBatchButton'
import { accessAllows } from '@/lib/auth/permissions'
import { listContentBatches } from '@/lib/tenant/content-batches'
import { listSocialSets } from '@/lib/tenant/write'
import { requireDraftsPageAccess } from '../../drafts/page-access'

export const metadata = { title: 'Bulk tools · Publish' }

/** Open bulk batches, and a way to start one in a publishing brand. */
export default async function BatchesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ set?: string }>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const access = await requireDraftsPageAccess(locale, '/publish/batches')
  const [{ batches }, sets] = await Promise.all([
    listContentBatches(access.tenant),
    listSocialSets(access.tenant),
  ])
  const canEdit = accessAllows(access, 'artifact:edit')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title="Bulk tools"
        description="Prepare up to 100 separate posts at once from videos, folders of images or a CSV. Each becomes its own draft, so review and scheduling work as they do for one draft. A batch saves as you go."
      >
        {canEdit ? (
          <Section
            title="Start a batch"
            description="Name it and choose the publishing brand whose accounts its posts go to."
          >
            {sets.length ? (
              <Group>
                <Row>
                  <NewBatchButton
                    sets={sets.map((set) => ({ id: set.id, name: set.name }))}
                    defaultSetId={query.set}
                  />
                </Row>
              </Group>
            ) : (
              <Button asChild variant="outline" className="w-fit">
                <Link href="/settings/publishing-brands">Connect a social account to start a batch</Link>
              </Button>
            )}
          </Section>
        ) : null}
        <Section title="Open batches">
          {batches.length ? (
            <Group>
              {batches.map((batch) => (
                <Row
                  key={batch.id}
                  layout="inline"
                  label={
                    <SidebarLink className="hover:underline" href={`/publish/batches/${batch.id}`}>
                      {batch.title}
                    </SidebarLink>
                  }
                  description={
                    sets.find((set) => set.id === batch.socialSetId)?.name ?? 'Publishing brand'
                  }
                >
                  <Pill>
                    {batch.itemCount} {batch.itemCount === 1 ? 'post' : 'posts'}
                  </Pill>
                </Row>
              ))}
            </Group>
          ) : (
            <EmptyState
              icon={LibraryIcon}
              title="No open batches"
              description="A batch turns up to 100 videos, folders of images or CSV rows into separate drafts you can review and schedule together."
            />
          )}
        </Section>
      </Page>
    </PlatformShell>
  )
}

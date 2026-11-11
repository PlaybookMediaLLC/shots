import Link from 'next/link'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { EmptyState, Group, Page, Pill, Section } from '@/components/platform-ui'
import { BatchIcon, ChevronRightIcon, LibraryIcon } from '@/components/platform-shell/icons'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { DiscardBatchButton } from '@/components/write/batch/DiscardBatchButton'
import { NewBatchButton } from '@/components/write/batch/NewBatchButton'
import { accessAllows } from '@/lib/auth/permissions'
import { listContentBatches } from '@/lib/tenant/content-batches'
import { listSocialSets } from '@/lib/tenant/write'
import { requireDraftsPageAccess } from '../../drafts/page-access'

export const metadata = { title: 'Bulk tools · Publish' }

/** Open bulk batches, and a way to start one in a profile. */
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
            description="Pick what you are posting, then name it and choose the profile whose accounts its posts go to."
          >
            {sets.length ? (
              <NewBatchButton
                sets={sets.map((set) => ({ id: set.id, name: set.name }))}
                defaultSetId={query.set}
              />
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
                <div
                  className="group relative flex min-w-0 items-center gap-3 px-4 py-3 transition-colors hover:bg-foreground/[0.025]"
                  key={batch.id}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-foreground/[0.03] text-muted-foreground"
                  >
                    <BatchIcon size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* The link covers the row; the discard button sits above it. */}
                    <h3 className="min-w-0">
                      <SidebarLink
                        className="block truncate text-ui-lg text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        href={`/publish/batches/${batch.id}`}
                        title={batch.title}
                      >
                        {batch.title}
                      </SidebarLink>
                    </h3>
                    <p className="mt-0.5 truncate text-ui text-muted-foreground">
                      {sets.find((set) => set.id === batch.socialSetId)?.name ?? 'Profile'}
                    </p>
                  </div>
                  <Pill tone={batch.itemCount ? 'blue' : 'gray'}>
                    {batch.itemCount} {batch.itemCount === 1 ? 'post' : 'posts'}
                  </Pill>
                  {/* Starting a batch creates it before its first file or row, so an
                      abandoned start needs a way out of this list. */}
                  {canEdit && batch.itemCount === 0 ? (
                    <span className="relative">
                      <DiscardBatchButton id={batch.id} title={batch.title} />
                    </span>
                  ) : null}
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5"
                    size={14}
                  />
                </div>
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

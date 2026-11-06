import { CREATE_LINKS, STORE_SCREENSHOTS } from '@/lib/platform/navigation'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { RecentWork } from '@/components/platform-hub/RecentWork'
import { ResourceCards } from '@/components/platform-hub/ResourceCards'
import { TemplateBrowser } from '@/components/platform-hub/TemplateBrowser'
import { requirePaidPageAccess } from '@/lib/auth/page-access'

type CreatePageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ view?: string }>
}

/** The tab title names the Create page shown, as the sidebar does. */
export async function generateMetadata({ searchParams }: CreatePageProps): Promise<Metadata> {
  const { view } = await searchParams
  const href = view ? `/create?view=${view}` : '/create'
  const page = CREATE_LINKS.find((link) => link.href === href)?.label ?? 'New'
  return { title: `${page} · Create` }
}

export default async function CreatePage({ params, searchParams }: CreatePageProps) {
  const [{ locale }, { view }] = await Promise.all([params, searchParams])
  const access = await requirePaidPageAccess(await headers(), locale, '/create')
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page title="Create" description="Turn a screenshot into a finished visual.">
        <AreaNavigation label="Create" items={CREATE_LINKS} />
        {view === 'templates' ? (
          <TemplateBrowser />
        ) : view === 'recent' ? (
          // Recent screenshots and canvases, from the same list as Home's.
          <RecentWork draftsEnabled={false} organizationId={access.organization!.id} />
        ) : (
          <ResourceCards
            items={
              view === 'tools'
                ? [
                    {
                      title: 'Code Studio',
                      description:
                        'Turn a snippet, diff or pull request into an image, carousel or video, then post it.',
                      href: '/create/code',
                      scope: 'Code Studio · Save to workspace',
                    },
                    {
                      title: 'Tweet image',
                      description: 'Style a social post as a visual.',
                      href: '/tweet',
                      scope: 'Tweet editor',
                    },
                    {
                      title: 'Image tools',
                      description: 'Resize, crop, compress or convert an image.',
                      href: '/tools',
                      scope: 'Focused utilities',
                    },
                  ]
                : [
                    {
                      title: 'Polish a screenshot',
                      description:
                        'Frame a screen, adjust the background and export a finished image.',
                      href: '/editor?start=new',
                      scope: 'Screenshot · Save as a workspace project',
                      pages: [{ kind: 'screen', ratio: '16:9' }],
                    },
                    {
                      title: 'Compose a Canvas',
                      description: 'Build a visual story with editable artboards and layers.',
                      href: '/canvas',
                      scope: 'Canvas · Workspace',
                      pages: [
                        { kind: 'hero', ratio: '16:9' },
                        { kind: 'quote', ratio: '1:1' },
                        { kind: 'phone', ratio: '9:16' },
                      ],
                      add: true,
                    },
                    {
                      title: STORE_SCREENSHOTS.label,
                      description: 'Prepare store listings across devices, sizes and languages.',
                      href: STORE_SCREENSHOTS.href,
                      scope: 'App Store studio · On this browser',
                      pages: [
                        { kind: 'phone', ratio: '9:16' },
                        { kind: 'phone', ratio: '9:16' },
                        { kind: 'phone', ratio: '9:16' },
                        { kind: 'phone', ratio: '9:16' },
                      ],
                    },
                    {
                      title: 'Create a Story Set',
                      description: access.creativeSetsEnabled
                        ? 'Keep related stories and output formats together.'
                        : 'Early access for design partners. Saved sets stay available here.',
                      href: '/creative-sets',
                      scope: access.creativeSetsEnabled
                        ? 'Story Set · Workspace'
                        : 'Story Set · Early access',
                      pages: [
                        { kind: 'hero', ratio: '16:9' },
                        { kind: 'hero', ratio: '1:1' },
                        { kind: 'hero', ratio: '4:5' },
                      ],
                    },
                  ]
            }
          />
        )}
      </Page>
    </PlatformShell>
  )
}

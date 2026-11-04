import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation, CREATE_LINKS } from '@/components/platform-hub/AreaNavigation'
import { ResourceCards } from '@/components/platform-hub/ResourceCards'
import { TemplateBrowser } from '@/components/platform-hub/TemplateBrowser'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'

export const metadata = { title: 'Create' }
export default async function CreatePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ view?: string }>
}) {
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
        ) : (
          <ResourceCards
            items={
              view === 'tools'
                ? [
                    {
                      title: 'Code image',
                      description: 'Compose a code snippet as a shareable image.',
                      href: '/code',
                      scope: 'Code editor',
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
                      href: '/?start=new',
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

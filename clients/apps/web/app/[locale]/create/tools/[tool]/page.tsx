import { AssistantPageContext } from '@/components/assistant/AssistantProvider'
import type { Metadata } from 'next'
import dynamic from 'next/dynamic'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import {
  CompressIcon,
  ConvertIcon,
  CropIcon,
  EraserIcon,
  RefreshIcon,
  ResizeIcon,
  VideoIcon,
} from '@/components/platform-shell/icons'
import { Page } from '@/components/platform-ui'
import { CompressVideoLoader } from '@/components/compress-video/CompressVideoLoader'
import { RemoveBackgroundLoader } from '@/components/remove-background/RemoveBackgroundLoader'
import { ToolWorkspace } from '@/components/tools/ToolWorkspace'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { IN_APP_TOOLS } from '@/lib/platform/navigation'
import { getTool } from '@/lib/seo/tools'
import { cn } from '@/lib/utils'

const CropWorkspace = dynamic(() =>
  import('@/components/tools/CropWorkspace').then((mod) => mod.CropWorkspace)
)

const ICONS: Record<(typeof IN_APP_TOOLS)[number]['slug'], typeof CropIcon> = {
  'compress-image': CompressIcon,
  'convert-image': ConvertIcon,
  'resize-image': ResizeIcon,
  'crop-image': CropIcon,
  'rotate-image': RefreshIcon,
  'remove-background': EraserIcon,
  'compress-video': VideoIcon,
}

type ToolPageProps = { params: Promise<{ locale: string; tool: string }> }

export async function generateMetadata({ params }: ToolPageProps): Promise<Metadata> {
  const { tool } = await params
  const title = IN_APP_TOOLS.find((entry) => entry.slug === tool)?.title
  return { title: title ? `${title} · Image tools` : 'Image tools' }
}

/**
 * The image tools inside the app: the tools on the left, the open one on the
 * right. Each tool keeps its URL; the public page at /<tool> stays for search.
 */
export default async function InAppToolPage({ params }: ToolPageProps) {
  const { locale, tool: slug } = await params
  const entry = IN_APP_TOOLS.find((candidate) => candidate.slug === slug)
  if (!entry) notFound()
  const access = await requirePaidPageAccess(await headers(), locale, `/create/tools/${slug}`)
  const tool = getTool(`/${slug}`)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <AssistantPageContext facts={[`The ${entry.title} image tool. Images stay on this device.`]} />
      <Page title="Image tools" description="Edit images on this device. Nothing is uploaded.">
        <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
          <nav
            aria-label="Image tools"
            className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:grid md:content-start md:overflow-visible"
          >
            {IN_APP_TOOLS.map((item) => {
              const Icon = ICONS[item.slug]
              const current = item.slug === slug
              return (
                <SidebarLink
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors',
                    current
                      ? 'border-border bg-card text-foreground shadow-xs'
                      : 'border-transparent text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
                  )}
                  href={`/create/tools/${item.slug}`}
                  key={item.slug}
                >
                  <Icon aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="hidden text-xs text-muted-foreground md:block">
                      {item.description}
                    </span>
                  </span>
                </SidebarLink>
              )
            })}
          </nav>
          {/* The highlighted row names the open tool, so the pane holds only the tool.
              The tools center themselves at a reading width for their public pages;
              here they fill the pane beside the list. */}
          <section
            aria-label={entry.title}
            className="min-w-0 [&_[data-local-dropzone]>div]:max-w-none [&>*]:mx-0 [&>*]:max-w-none"
          >
            {slug === 'remove-background' ? (
              <RemoveBackgroundLoader />
            ) : slug === 'compress-video' ? (
              <CompressVideoLoader />
            ) : tool?.engine === 'crop' ? (
              <CropWorkspace tool={tool} />
            ) : tool ? (
              <ToolWorkspace tool={tool} />
            ) : (
              notFound()
            )}
          </section>
        </div>
      </Page>
    </PlatformShell>
  )
}

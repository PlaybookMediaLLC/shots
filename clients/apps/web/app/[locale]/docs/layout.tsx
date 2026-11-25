import '@/app/documentation.css'
import { DocsLayout as FumaDocsLayout } from 'fumadocs-ui/layouts/docs'
import type { ReactNode } from 'react'
import { Suspense } from 'react'
import { DocsSearchJsonLd } from '@/components/docs/docs-search-json-ld'
import { DocsSearchQuerySync } from '@/components/docs/docs-search-query-sync'
import { DocsShellNav } from '@/components/docs/docs-shell-nav'
import { DocsSidebar } from '@/components/docs/docs-sidebar'
import { docsSource, getDocsRootPage, getDocsSidebarSections } from '@/lib/docs/source'
import { DocsProvider } from './provider'

export default function DocsLayout({ children }: { children: ReactNode }) {
  const homePage = getDocsRootPage()
  const sections = getDocsSidebarSections()

  return (
    <>
      <DocsSearchJsonLd />
      <DocsProvider>
        <div className="docs-shell min-h-screen bg-background text-foreground lg:h-dvh lg:overflow-hidden">
          <Suspense fallback={null}>
            <DocsSearchQuerySync />
          </Suspense>
          <DocsShellNav homePage={homePage} sections={sections} />
          <DocsSidebar homePage={homePage} sections={sections} />
          <div className="docs-panel lg:ms-[16.75rem] lg:me-3 lg:mt-[3.25rem] lg:mb-3 lg:h-[calc(100dvh-4rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-2xl lg:border lg:border-border lg:bg-card">
            <FumaDocsLayout
              containerProps={{
                className: 'docs-layout',
              }}
              nav={{ enabled: false }}
              searchToggle={{ enabled: false }}
              sidebar={{ enabled: false }}
              themeSwitch={{ enabled: false }}
              tree={docsSource.pageTree}
            >
              {children}
            </FumaDocsLayout>
          </div>
        </div>
      </DocsProvider>
    </>
  )
}

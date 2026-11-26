import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { docsMdxComponents } from '@/components/docs/docs-mdx-components'
import { DocsBreadcrumbJsonLd } from '@/components/docs/docs-search-json-ld'
import { compileDocsMdx } from '@/lib/docs/mdx'
import { docsSource } from '@/lib/docs/source'
import { OG_DEFAULTS } from '@/lib/seo/metadata'

interface DocsPageProps {
  params: Promise<{ locale: string; slug?: string[] }>
}

export function generateStaticParams() {
  return docsSource.generateParams()
}

// The list above is complete. Disabling dynamic params ensures unknown slugs
// return 404 without writing unbounded cache entries to disk.
export const dynamicParams = false

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params
  const page = docsSource.getPage(slug)

  if (!page) {
    return {
      robots: { follow: false, index: false },
      title: 'Documentation Not Found',
    }
  }

  const docsPath = page.url
  const description =
    page.data.description ??
    'Product and API documentation for Shots: launch campaigns, visual editors, Automate workflows, signed-in capture, MCP agents, and the REST API.'
  const title =
    page.slugs.length === 0
      ? { absolute: 'Shots Documentation' }
      : { absolute: `${page.data.title} | Shots Docs` }

  return {
    alternates: {
      canonical: docsPath,
    },
    description,
    keywords: page.data.keywords.length > 0 ? page.data.keywords : undefined,
    openGraph: {
      ...OG_DEFAULTS,
      description,
      title: page.data.title,
      type: 'article',
      url: docsPath,
    },
    title,
    twitter: {
      card: 'summary_large_image',
      description,
      title: page.data.title,
    },
  }
}

export default async function DocsPageRoute({ params }: DocsPageProps) {
  const { slug } = await params
  const page = docsSource.getPage(slug)

  if (!page) {
    notFound()
  }

  const MdxContent = await compileDocsMdx(page)

  return (
    <DocsPage
      breadcrumb={{ enabled: false }}
      full={false}
      tableOfContent={{ style: 'clerk' }}
      toc={page.data.toc}
    >
      <DocsBreadcrumbJsonLd getPage={docsSource.getPage} slugs={page.slugs} />
      <DocsTitle>{page.data.title}</DocsTitle>
      {page.data.description ? <DocsDescription>{page.data.description}</DocsDescription> : null}
      <DocsBody>
        <MdxContent components={docsMdxComponents} />
      </DocsBody>
    </DocsPage>
  )
}

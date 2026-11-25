import type { DocsSourcePage } from '@/lib/docs/source'
import { SITE_URL } from '@/lib/seo/metadata'

function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/** WebSite + SearchAction JSON-LD for the docs hub (`/docs?q={search_term_string}`). */
export function DocsSearchJsonLd() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Shots Documentation',
    potentialAction: {
      '@type': 'SearchAction',
      'query-input': 'required name=search_term_string',
      target: `${SITE_URL}/docs?q={search_term_string}`,
    },
    url: `${SITE_URL}/docs`,
  }

  return (
    <script
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
      type="application/ld+json"
    />
  )
}

/** BreadcrumbList JSON-LD for a docs page. */
export function DocsBreadcrumbJsonLd({
  getPage,
  slugs,
}: {
  getPage: (slugs?: string[]) => DocsSourcePage | undefined
  slugs: string[]
}) {
  const items: { name: string; url: string }[] = [
    { name: 'Documentation', url: `${SITE_URL}/docs` },
  ]

  for (let index = 0; index < slugs.length; index += 1) {
    const prefix = slugs.slice(0, index + 1)
    const match = getPage(prefix)
    const name = match?.data.title ?? prefix.at(-1) ?? ''
    items.push({ name, url: `${SITE_URL}/docs/${prefix.join('/')}` })
  }

  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      item: item.url,
      name: item.name,
      position: index + 1,
    })),
  }

  return (
    <script
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
      type="application/ld+json"
    />
  )
}

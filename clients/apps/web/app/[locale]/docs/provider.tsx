'use client'

import { FrameworkProvider, type Framework } from 'fumadocs-core/framework'
import { RootProvider } from 'fumadocs-ui/provider/base'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { DocsSearchEntrySchema, type DocsSearchEntry } from '@/lib/docs/search-filter'
import { withoutLocale } from '@/lib/settings/appearance'

const DocsSearchDialog = dynamic(() => import('@/components/docs/docs-search-dialog'), {
  ssr: false,
})

let pendingIndex: Promise<DocsSearchEntry[]> | null = null

const loadSearchIndex = () => {
  pendingIndex ??= fetch('/docs/search-index.json')
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Search index returned ${response.status}`)
      }
      return DocsSearchEntrySchema.array().parse(await response.json())
    })
    .catch((error: unknown) => {
      pendingIndex = null
      throw error
    })
  return pendingIndex
}

type SearchIndexState =
  | { readonly pages: DocsSearchEntry[]; readonly status: 'loading' }
  | { readonly pages: DocsSearchEntry[]; readonly status: 'failed' }
  | { readonly pages: DocsSearchEntry[]; readonly status: 'ready' }

/**
 * Loads the static docs search index lazily when the search dialog first opens,
 * keeping initial docs HTML lean.
 */
export function useDocsPages(open: boolean): SearchIndexState {
  const [index, setIndex] = useState<SearchIndexState>({
    pages: [],
    status: 'loading',
  })
  const isReady = index.status === 'ready'

  useEffect(() => {
    if (!open || isReady) return

    let active = true
    setIndex({ pages: [], status: 'loading' })
    loadSearchIndex()
      .then((pages) => {
        if (active) setIndex({ pages, status: 'ready' })
      })
      .catch(() => {
        if (active) setIndex({ pages: [], status: 'failed' })
      })
    return () => {
      active = false
    }
  }, [isReady, open])

  return index
}

/** Strips next-intl locale prefixes so SSR (`/en/docs`) matches client (`/docs`) and pageTree URLs. */
function useDocsPathname(): string {
  return withoutLocale(usePathname() ?? '/docs')
}

const DocsLink: NonNullable<Framework['Link']> = ({ href = '', prefetch, ...props }) => (
  <Link href={href} prefetch={prefetch} {...props} />
)

export function DocsProvider({ children }: { children: ReactNode }) {
  return (
    <FrameworkProvider
      Link={DocsLink}
      useParams={useParams}
      usePathname={useDocsPathname}
      useRouter={useRouter}
    >
      <RootProvider
        search={{
          SearchDialog: DocsSearchDialog,
          preload: false,
        }}
        theme={{
          // Root layout already mounts next-themes via AppThemeProvider.
          enabled: false,
        }}
      >
        {children}
      </RootProvider>
    </FrameworkProvider>
  )
}

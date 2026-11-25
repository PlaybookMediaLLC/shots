'use client'

import { useSearchContext } from 'fumadocs-ui/contexts/search'
import { useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Opens the docs search dialog when visitors or crawlers land with `?q=` or
 * `?search=` (matching the SearchAction urlTemplate in JSON-LD).
 */
export function DocsSearchQuerySync() {
  const searchParams = useSearchParams()
  const { setOpenSearch } = useSearchContext()

  useEffect(() => {
    const query = searchParams.get('q')?.trim() || searchParams.get('search')?.trim()
    if (!query) return
    setOpenSearch(true)
  }, [searchParams, setOpenSearch])

  return null
}

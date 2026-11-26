import { z } from 'zod'

/** Content classification badge shown on search results. */
export const DocsContentTypeSchema = z.enum([
  'documentation',
  'api-reference',
  'guide',
  'reference',
])

/** Validated search entry returned by `/docs/search-index.json`. */
export const DocsSearchEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().startsWith('/docs'),
  description: z.string().optional(),
  excerpt: z.string().optional(),
  contentType: DocsContentTypeSchema,
  category: z.string().min(1),
  keywords: z.string().array().default([]),
})

export type DocsSearchEntry = z.infer<typeof DocsSearchEntrySchema>

export interface IndexedDocsSearchEntry {
  badge: string
  categoryLower: string
  descriptionLower: string
  entry: DocsSearchEntry
  keywordsLower: string[]
  titleLower: string
  urlLower: string
}

/** Pre-lowercases searchable fields once when the search index loads. */
export function indexDocsSearchEntries(
  entries: readonly DocsSearchEntry[]
): IndexedDocsSearchEntry[] {
  return entries.map((entry) => {
    const badge = entry.contentType.replaceAll('-', ' ')
    return {
      badge,
      categoryLower: entry.category.toLowerCase(),
      descriptionLower: (entry.description ?? entry.excerpt ?? '').toLowerCase(),
      entry,
      keywordsLower: entry.keywords.map((keyword) => keyword.toLowerCase()),
      titleLower: entry.title.toLowerCase(),
      urlLower: entry.url.toLowerCase(),
    }
  })
}

function matchRank(item: IndexedDocsSearchEntry, normalized: string): number {
  if (item.titleLower === normalized) return 0
  if (item.titleLower.startsWith(normalized)) return 1
  if (item.titleLower.includes(normalized)) return 2
  if (item.urlLower.includes(normalized)) return 3
  if (item.descriptionLower.includes(normalized)) return 4
  if (item.badge.includes(normalized) || item.categoryLower.includes(normalized)) return 5
  if (item.keywordsLower.some((value) => value.includes(normalized))) return 6
  return -1
}

/** Client-side search filter prioritizing title/URL matches over body matches. */
export function filterDocsPages(
  entries: readonly DocsSearchEntry[],
  search: string
): DocsSearchEntry[] {
  return filterIndexedDocsPages(indexDocsSearchEntries(entries), search).map((item) => item.entry)
}

/** Fast search filter over pre-indexed entries for interactive typing in the search modal. */
export function filterIndexedDocsPages(
  indexed: readonly IndexedDocsSearchEntry[],
  search: string
): IndexedDocsSearchEntry[] {
  const normalized = search.trim().toLowerCase()
  if (normalized.length === 0) {
    return [...indexed]
  }

  return indexed
    .map((item, index) => ({ index, item, rank: matchRank(item, normalized) }))
    .filter((candidate) => candidate.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((candidate) => candidate.item)
}

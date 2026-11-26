const SECTION_HEADING_PATTERN = /^##\s+(.+)$/
const DOC_LINK_PATTERN = /^- \[[^\]]+\]\((\/docs(?:\/[^)#?]+)?)\)/
const FALLBACK_GROUP_TITLE = 'More'

export const DOCS_BASE_PATH = '/docs'
export const ROOT_DOC_SLUG = 'index'

export interface DocsNavigationDocument {
  slug: string
  title: string
}

export interface DocsNavigationEntry {
  title: string
  url: string
}

export interface DocsNavigationGroup {
  items: DocsNavigationEntry[]
  title: string
}

export interface DocsNavSectionLike {
  groups: readonly DocsNavigationGroup[]
  url?: string
}

interface NavigationState {
  currentGroup?: DocsNavigationGroup
  documentsByUrl: Map<string, DocsNavigationDocument>
  groups: DocsNavigationGroup[]
  linkedUrls: Set<string>
}

export const getDocsUrl = (slug: string): string =>
  slug === ROOT_DOC_SLUG ? DOCS_BASE_PATH : `${DOCS_BASE_PATH}/${slug}`

/** Whether `pathname` (already locale-stripped) matches a section index or any grouped link. */
export function sectionContainsPath(section: DocsNavSectionLike, pathname: string): boolean {
  if (section.url === pathname) return true
  return section.groups.some((group) => group.items.some((item) => item.url === pathname))
}

const toNavigationEntry = (document: DocsNavigationDocument): DocsNavigationEntry => ({
  title: document.title,
  url: getDocsUrl(document.slug),
})

const addGroup = (groups: DocsNavigationGroup[], title: string): DocsNavigationGroup => {
  const group: DocsNavigationGroup = { items: [], title }
  groups.push(group)
  return group
}

const applyIndexLine = (state: NavigationState, line: string): void => {
  const heading = line.match(SECTION_HEADING_PATTERN)?.[1]?.trim()
  if (heading) {
    state.currentGroup = addGroup(state.groups, heading)
    return
  }

  const url = line.match(DOC_LINK_PATTERN)?.[1]
  const document = url ? state.documentsByUrl.get(url) : undefined
  if (!(url && document && state.currentGroup) || state.linkedUrls.has(url)) {
    return
  }

  state.currentGroup.items.push(toNavigationEntry(document))
  state.linkedUrls.add(url)
}

/**
 * Derives ordered sidebar navigation groups from a section's `index.mdx` headings
 * and bullet links. Any routed doc not linked from the section index falls into a
 * `More` group so it never disappears from navigation.
 */
export const getDocsNavigationGroups = (
  indexContent: string | undefined,
  documents: readonly DocsNavigationDocument[]
): DocsNavigationGroup[] => {
  const documentsByUrl = new Map(
    documents.map((document) => [getDocsUrl(document.slug), document])
  )
  const state: NavigationState = {
    documentsByUrl,
    groups: [],
    linkedUrls: new Set<string>(),
  }

  for (const line of indexContent?.split('\n') ?? []) {
    applyIndexLine(state, line)
  }

  const unlinkedDocuments = documents.filter(
    (document) => !state.linkedUrls.has(getDocsUrl(document.slug))
  )
  if (unlinkedDocuments.length > 0) {
    state.groups.push({
      items: unlinkedDocuments.map(toNavigationEntry),
      title: FALLBACK_GROUP_TITLE,
    })
  }

  return state.groups.filter((group) => group.items.length > 0)
}

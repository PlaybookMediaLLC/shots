import fs from 'node:fs'
import path from 'node:path'
import { cache } from 'react'
import { frontmatter } from 'fumadocs-core/content/md/frontmatter'
import { getTableOfContents } from 'fumadocs-core/content/toc'
import type { Item, Node, Root } from 'fumadocs-core/page-tree'
import type { TableOfContents } from 'fumadocs-core/toc'
import { z } from 'zod'
import { API_KEY_PLACEHOLDER, MCP_CLIENTS, MCP_TOOLS, MCP_URL } from '@/lib/agents/mcp-clients'
import { apiKeyScopeDescriptions, apiKeyScopes } from '@/lib/auth/api-key-scopes'
import {
  DOCS_BASE_PATH,
  ROOT_DOC_SLUG,
  getDocsNavigationGroups,
  getDocsUrl,
  type DocsNavigationEntry,
  type DocsNavigationGroup,
} from './navigation-groups'
import { DocsSearchEntrySchema, type DocsSearchEntry } from './search-filter'

const MDX_EXTENSION_PATTERN = /\.mdx$/
const MAX_SEARCH_BODY_CHARS = 1500

export const DOC_SECTIONS = [
  { id: 'getting-started', name: 'Getting Started', prefix: 'getting-started' },
  { id: 'features', name: 'Features', prefix: 'features' },
  { id: 'guides', name: 'Guides', prefix: 'guides' },
  { id: 'api', name: 'API Reference', prefix: 'api' },
  { id: 'reference', name: 'Reference', prefix: 'reference' },
] as const

export type DocsSectionId = (typeof DOC_SECTIONS)[number]['id']

/**
 * Legacy top-level URLs that keep their existing canonical addresses
 * (`/docs/authentication`, `/docs/agents`, `/docs/automate`) while sitting
 * inside their natural sidebar section.
 */
const TOP_LEVEL_SECTION_OWNERS: Readonly<Record<string, DocsSectionId>> = {
  agents: 'api',
  authentication: 'api',
  automate: 'guides',
}

const DocFrontmatterSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  keywords: z.string().array().optional(),
})

export type DocsPageEntry = DocsNavigationEntry

export interface DocsSidebarSection {
  groups: DocsNavigationGroup[]
  id: DocsSectionId
  title: string
  url?: string
}

interface LoadedDoc {
  content: string
  description?: string
  filePath: string
  keywords: string[]
  slug: string
  title: string
  toc?: TableOfContents
}

export interface DocsSourcePage {
  data: {
    content: string
    description?: string
    keywords: string[]
    title: string
    toc: TableOfContents
  }
  path: string
  slugs: string[]
  url: string
}

interface GroupedSection {
  childDocs: LoadedDoc[]
  groups: DocsNavigationGroup[]
  section: (typeof DOC_SECTIONS)[number]
  sectionIndex?: LoadedDoc
}

interface DocsIndex {
  docsBySlug: Map<string, LoadedDoc>
  orderedDocs: LoadedDoc[]
  pageTree: Root
  rootPage?: DocsPageEntry
  sidebarSections: DocsSidebarSection[]
}

function resolveDocsContentDir(): string {
  const candidates = [
    path.join(process.cwd(), 'content/docs'),
    path.join(process.cwd(), 'clients/apps/web/content/docs'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(`Docs content directory not found. Checked: ${candidates.join(', ')}`)
}

function listMdxFiles(dir: string, base = ''): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...listMdxFiles(path.join(dir, entry.name), relativePath))
    } else if (entry.name.endsWith('.mdx')) {
      files.push(relativePath)
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function filePathToSlug(filePath: string): string {
  const parts = filePath.replace(MDX_EXTENSION_PATTERN, '').split('/')
  if (parts.at(-1) === 'index') {
    return parts.slice(0, -1).join('/') || ROOT_DOC_SLUG
  }
  return parts.join('/')
}

function loadDocsFromDisk(): LoadedDoc[] {
  const contentDir = resolveDocsContentDir()
  const files = listMdxFiles(contentDir)
  const seenSlugs = new Set<string>()
  const loaded: LoadedDoc[] = []

  for (const relativePath of files) {
    const raw = fs.readFileSync(path.join(contentDir, relativePath), 'utf8')
    const parsed = frontmatter(raw)
    const metaResult = DocFrontmatterSchema.safeParse(parsed.data)
    if (!metaResult.success) {
      throw new Error(
        `Invalid frontmatter in content/docs/${relativePath}: ${metaResult.error.message}`
      )
    }

    const slug = filePathToSlug(relativePath)
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate docs slug "${slug}" from ${relativePath}`)
    }
    seenSlugs.add(slug)

    loaded.push({
      content: parsed.content.trim(),
      description: metaResult.data.description,
      filePath: relativePath,
      keywords: metaResult.data.keywords ?? [],
      slug,
      title: metaResult.data.title,
    })
  }

  return loaded
}

function sectionForSlug(slug: string): DocsSectionId | undefined {
  if (slug === ROOT_DOC_SLUG) return undefined
  if (TOP_LEVEL_SECTION_OWNERS[slug]) return TOP_LEVEL_SECTION_OWNERS[slug]
  const firstSegment = slug.split('/')[0]
  return DOC_SECTIONS.find((section) => section.prefix === firstSegment)?.id
}

function toPageEntry(doc: LoadedDoc): DocsPageEntry {
  return {
    title: doc.title,
    url: getDocsUrl(doc.slug),
  }
}

function toPageItem(doc: LoadedDoc): Item {
  return {
    description: doc.description,
    name: doc.title,
    type: 'page',
    url: getDocsUrl(doc.slug),
  }
}

function groupSections(allDocs: readonly LoadedDoc[]): GroupedSection[] {
  const grouped: GroupedSection[] = []

  for (const section of DOC_SECTIONS) {
    const sectionDocs = allDocs.filter((doc) => sectionForSlug(doc.slug) === section.id)
    if (sectionDocs.length === 0) continue

    const sectionIndex = sectionDocs.find((doc) => doc.slug === section.prefix)
    const childDocs = sectionDocs.filter((doc) => doc.slug !== section.prefix)
    const groups = getDocsNavigationGroups(sectionIndex?.content, childDocs)

    grouped.push({ childDocs, groups, section, sectionIndex })
  }

  return grouped
}

function buildDocsIndex(): DocsIndex {
  const allDocs = loadDocsFromDisk()
  const docsBySlug = new Map(allDocs.map((doc) => [doc.slug, doc]))
  const groupedSections = groupSections(allDocs)
  const rootDoc = docsBySlug.get(ROOT_DOC_SLUG)

  const orderedDocs: LoadedDoc[] = []
  const included = new Set<string>()
  const treeChildren: Node[] = []
  const sidebarSections: DocsSidebarSection[] = []

  if (rootDoc) {
    orderedDocs.push(rootDoc)
    included.add(rootDoc.slug)
    treeChildren.push(toPageItem(rootDoc))
  }

  for (const { childDocs, groups, section, sectionIndex } of groupedSections) {
    if (sectionIndex) {
      orderedDocs.push(sectionIndex)
      included.add(sectionIndex.slug)
    }

    for (const group of groups) {
      for (const item of group.items) {
        const match = childDocs.find((doc) => getDocsUrl(doc.slug) === item.url)
        if (match && !included.has(match.slug)) {
          orderedDocs.push(match)
          included.add(match.slug)
        }
      }
    }

    const sectionUrl = sectionIndex ? getDocsUrl(sectionIndex.slug) : undefined
    if (sectionUrl || groups.length > 0) {
      sidebarSections.push({
        groups,
        id: section.id,
        title: section.name,
        url: sectionUrl,
      })
    }

    if (sectionIndex && childDocs.length === 0) {
      treeChildren.push(toPageItem(sectionIndex))
      continue
    }

    treeChildren.push({
      children: groups.map((group) => ({
        children: group.items
          .map((item) => childDocs.find((doc) => getDocsUrl(doc.slug) === item.url))
          .filter((doc): doc is LoadedDoc => doc !== undefined)
          .map(toPageItem),
        name: group.title,
        type: 'folder',
      })),
      defaultOpen: true,
      description: sectionIndex?.description,
      index: sectionIndex ? toPageItem(sectionIndex) : undefined,
      name: section.name,
      type: 'folder',
    })
  }

  for (const doc of allDocs) {
    if (!included.has(doc.slug)) {
      orderedDocs.push(doc)
      included.add(doc.slug)
    }
  }

  return {
    docsBySlug,
    orderedDocs,
    pageTree: {
      $id: 'shots-docs',
      children: treeChildren,
      name: 'Documentation',
    },
    rootPage: rootDoc ? toPageEntry(rootDoc) : undefined,
    sidebarSections,
  }
}

let cachedIndex: DocsIndex | null = null
const getDevRequestIndex = cache(() => buildDocsIndex())

function getDocsIndex(): DocsIndex {
  if (process.env.NODE_ENV === 'development') {
    return getDevRequestIndex()
  }
  cachedIndex ??= buildDocsIndex()
  return cachedIndex
}

function getDocToc(doc: LoadedDoc): TableOfContents {
  doc.toc ??= getTableOfContents(doc.content)
  return doc.toc
}

function toSourcePage(doc: LoadedDoc): DocsSourcePage {
  return {
    data: {
      content: doc.content,
      description: doc.description,
      keywords: doc.keywords,
      title: doc.title,
      toc: getDocToc(doc),
    },
    path: doc.filePath,
    slugs: doc.slug === ROOT_DOC_SLUG ? [] : doc.slug.split('/'),
    url: getDocsUrl(doc.slug),
  }
}

export function getDocsRootPage(): DocsPageEntry | undefined {
  return getDocsIndex().rootPage
}

export function getDocsPageEntries(): DocsPageEntry[] {
  return getDocsIndex().orderedDocs.map(toPageEntry)
}

export function getDocsSidebarSections(): DocsSidebarSection[] {
  return getDocsIndex().sidebarSections
}

function normalizeSearchText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contentTypeForSlug(slug: string): DocsSearchEntry['contentType'] {
  const section = sectionForSlug(slug)
  if (section === 'api') return 'api-reference'
  if (section === 'guides') return 'guide'
  if (section === 'reference') return 'reference'
  return 'documentation'
}

function categoryForSlug(slug: string): string {
  const sectionId = sectionForSlug(slug)
  const section = DOC_SECTIONS.find((entry) => entry.id === sectionId)
  return section?.name ?? 'Documentation'
}

/** Static search index payload served at `/docs/search-index.json`. */
export function getDocsSearchEntries(): DocsSearchEntry[] {
  return DocsSearchEntrySchema.array().parse(
    getDocsIndex().orderedDocs.map((doc) => {
      const normalized = normalizeSearchText(doc.content)
      return {
        category: categoryForSlug(doc.slug),
        contentType: contentTypeForSlug(doc.slug),
        description: doc.description,
        excerpt: normalized.slice(0, 220),
        id: `docs:${doc.slug}`,
        keywords: [...doc.keywords, normalized.slice(0, MAX_SEARCH_BODY_CHARS)],
        title: doc.title,
        url: getDocsUrl(doc.slug),
      }
    })
  )
}

function renderApiKeyScopesMarkdown(): string {
  return [
    '| Scope | Permitted actions |',
    '| --- | --- |',
    ...apiKeyScopes.map(
      (scope) => `| \`${scope}\` | ${apiKeyScopeDescriptions[scope].replace(/\|/g, '\\|')} |`
    ),
  ].join('\n')
}

function renderMcpToolsMarkdown(): string {
  return [
    '| Tool | Scope | Summary |',
    '| --- | --- | --- |',
    ...MCP_TOOLS.map(
      (tool) => `| \`${tool.name}\` | \`${tool.scope}\` | ${tool.summary.replace(/\|/g, '\\|')} |`
    ),
  ].join('\n')
}

function renderMcpClientsMarkdown(): string {
  return [
    `Endpoint URL: \`${MCP_URL}\``,
    '',
    ...MCP_CLIENTS.flatMap((client) => [
      `### ${client.name}`,
      '',
      client.location,
      '',
      `\`\`\`${client.language}`,
      client.snippet(MCP_URL, API_KEY_PLACEHOLDER),
      '```',
      '',
      ...client.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
    ]),
  ]
    .join('\n')
    .trim()
}

function expandLiveMdxComponents(content: string): string {
  return content
    .replace(/<ApiKeyScopesTable\s*\/>/g, () => renderApiKeyScopesMarkdown())
    .replace(/<McpToolsTable\s*\/>/g, () => renderMcpToolsMarkdown())
    .replace(/<McpClientsList\s*\/>/g, () => renderMcpClientsMarkdown())
}

/** Markdown representation of a docs page for `Accept: text/markdown` clients. */
export function getDocsMarkdown(pathname: string): { content: string; title: string } | undefined {
  const normalized = pathname.replace(/\/+$/, '') || '/'
  if (normalized !== DOCS_BASE_PATH && !normalized.startsWith(`${DOCS_BASE_PATH}/`)) {
    return undefined
  }
  const slugs =
    normalized === DOCS_BASE_PATH ? [] : normalized.slice(`${DOCS_BASE_PATH}/`.length).split('/')
  if (slugs.some((segment) => segment.length === 0)) {
    return undefined
  }

  const doc = lookupDocBySlugs(slugs)
  if (!doc) return undefined

  const lines = [`# ${doc.title}`]
  if (doc.description) {
    lines.push('', doc.description)
  }
  lines.push('', expandLiveMdxComponents(doc.content))
  return { content: `${lines.join('\n')}\n`, title: doc.title }
}

function lookupDocBySlugs(slugs?: string[]): LoadedDoc | undefined {
  if (slugs && slugs.length > 0) {
    if (slugs.some((segment) => segment.length === 0)) return undefined
    const joined = slugs.join('/')
    // `/docs/index` is not a valid public route (`generateStaticParams` serves root at `/docs`).
    if (joined === ROOT_DOC_SLUG) return undefined
    return getDocsIndex().docsBySlug.get(joined)
  }
  return getDocsIndex().docsBySlug.get(ROOT_DOC_SLUG)
}

export const docsSource = {
  get pageTree(): Root {
    return getDocsIndex().pageTree
  },
  generateParams: (): { slug: string[] }[] =>
    getDocsIndex().orderedDocs.map((doc) => ({
      slug: doc.slug === ROOT_DOC_SLUG ? [] : doc.slug.split('/'),
    })),
  getPage: (slugs?: string[]): DocsSourcePage | undefined => {
    const doc = lookupDocBySlugs(slugs)
    return doc ? toSourcePage(doc) : undefined
  },
}

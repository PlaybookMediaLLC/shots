import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GET as getSearchIndex } from '../app/docs/search-index.json/route'
import sitemap from '../app/sitemap'
import { generateMetadata } from '../app/[locale]/docs/[[...slug]]/page'
import { docsMdxComponents } from '../components/docs/docs-mdx-components'
import { agentMarkdownResponse } from '../lib/agents/markdown-response'
import { MCP_CLIENTS, MCP_TOOLS } from '../lib/agents/mcp-clients'
import { apiKeyScopes } from '../lib/auth/api-key-scopes'
import { compileDocsMdx } from '../lib/docs/mdx'
import { DocsSearchEntrySchema } from '../lib/docs/search-filter'
import {
  DOC_SECTIONS,
  docsSource,
  getDocsMarkdown,
  getDocsPageEntries,
  getDocsSearchEntries,
  getDocsSidebarSections,
} from '../lib/docs/source'

const DOCS_CONTENT_DIR = path.join(process.cwd(), 'content/docs')

const listExpectedDocUrls = (dir: string, base = ''): string[] => {
  const urls: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      urls.push(...listExpectedDocUrls(path.join(dir, entry.name), relativePath))
      continue
    }
    if (!entry.name.endsWith('.mdx')) continue
    const slug = relativePath.replace(/\.mdx$/, '').replace(/(^|\/)index$/, '')
    urls.push(slug ? `/docs/${slug}` : '/docs')
  }
  return urls
}

const params = docsSource.generateParams()
const pages = params
  .map((param) => docsSource.getPage(param.slug))
  .filter((page): page is NonNullable<typeof page> => Boolean(page))

test('publishes every MDX file on disk under content/docs', () => {
  const published = new Set(pages.map((page) => page.url))
  const missing = listExpectedDocUrls(DOCS_CONTENT_DIR).filter((url) => !published.has(url))
  assert.deepEqual(missing, [])
  assert.equal(pages.length, params.length)
})

test('links every section doc from its section index and uses no More fallback group', () => {
  for (const section of DOC_SECTIONS) {
    const sectionDir = path.join(DOCS_CONTENT_DIR, section.prefix)
    const indexContent = fs.readFileSync(path.join(sectionDir, 'index.mdx'), 'utf8')
    const orphans = fs
      .readdirSync(sectionDir)
      .filter((name) => name.endsWith('.mdx') && name !== 'index.mdx')
      .map((name) => name.replace(/\.mdx$/, ''))
      .filter((slug) => !indexContent.includes(`/docs/${section.prefix}/${slug})`))
    assert.deepEqual(orphans, [], `Unlinked ${section.prefix} pages: ${orphans.join(', ')}`)
  }

  const fallbackSections = getDocsSidebarSections()
    .filter((section) => section.groups.some((group) => group.title === 'More'))
    .map((section) => section.id)
  assert.deepEqual(fallbackSections, [])
})

test('gives every doc a title, description, body, and valid table of contents', () => {
  const failures = pages
    .filter(
      (page) =>
        !(
          page.data.title &&
          page.data.description &&
          page.data.content &&
          Array.isArray(page.data.toc)
        )
    )
    .map((page) => page.url)
  assert.deepEqual(failures, [])
})

test('compiles and renders every doc to non-empty HTML with valid links, anchors, TOC IDs, and live registries', async () => {
  const publishedUrls = new Set(pages.map((page) => page.url))
  const brokenLinks: string[] = []
  const brokenFragments: string[] = []
  const brokenTocIds: string[] = []
  const renderedByUrl = new Map<string, string>()

  for (const page of pages) {
    const Mdx = await compileDocsMdx(page)
    const html = renderToStaticMarkup(React.createElement(Mdx, { components: docsMdxComponents }))
    assert.ok(html.trim().length > 0, `Empty render for ${page.url}`)
    renderedByUrl.set(page.url, html)

    for (const tocItem of page.data.toc) {
      const id = tocItem.url.replace(/^#/, '')
      if (!html.includes(`id="${id}"`)) {
        brokenTocIds.push(`${page.url} missing heading id="${id}"`)
      }
    }
  }

  for (const page of pages) {
    const html = renderedByUrl.get(page.url) ?? ''
    for (const match of html.matchAll(/<a[^>]+href="(\/docs[^"?]*|#[^"]+)"/g)) {
      const href = match[1]!
      if (href.startsWith('#')) {
        const id = href.slice(1)
        if (!html.includes(`id="${id}"`)) {
          brokenFragments.push(`${page.url} -> ${href}`)
        }
        continue
      }

      const [targetPath, fragment] = href.split('#')
      if (!publishedUrls.has(targetPath!)) {
        brokenLinks.push(`${page.url} -> ${targetPath}`)
        continue
      }
      if (fragment) {
        const targetHtml = renderedByUrl.get(targetPath!) ?? ''
        if (!targetHtml.includes(`id="${fragment}"`)) {
          brokenFragments.push(`${page.url} -> ${href}`)
        }
      }
    }
  }

  assert.deepEqual(brokenLinks, [])
  assert.deepEqual(brokenFragments, [])
  assert.deepEqual(brokenTocIds, [])

  const authHtml = renderedByUrl.get('/docs/authentication') ?? ''
  const scopesHtml = renderedByUrl.get('/docs/reference/api-scopes') ?? ''
  for (const scope of apiKeyScopes) {
    assert.ok(authHtml.includes(scope), `/docs/authentication missing scope ${scope}`)
    assert.ok(scopesHtml.includes(scope), `/docs/reference/api-scopes missing scope ${scope}`)
  }

  const agentsHtml = renderedByUrl.get('/docs/agents') ?? ''
  for (const tool of MCP_TOOLS) {
    assert.ok(agentsHtml.includes(tool.name), `/docs/agents missing tool ${tool.name}`)
  }
  for (const client of MCP_CLIENTS) {
    assert.ok(agentsHtml.includes(`id="${client.id}"`), `/docs/agents missing client #${client.id}`)
    assert.ok(agentsHtml.includes(client.name), `/docs/agents missing client ${client.name}`)
  }

  const automateHtml = renderedByUrl.get('/docs/automate') ?? ''
  assert.match(automateHtml, /Watch a Repository/i)

  const homeHtml = renderedByUrl.get('/docs') ?? ''
  assert.match(homeHtml, /id="errors"/i)
})

test('search index route serves schema-valid JSON with cache headers covering every doc', async () => {
  const response = getSearchIndex()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600')
  const json = await response.json()
  const entries = DocsSearchEntrySchema.array().parse(json)
  assert.equal(entries.length, pages.length)
  assert.deepEqual(entries, getDocsSearchEntries())
})

test('docsSource, getDocsMarkdown, and agentMarkdownResponse enforce 404 parity and expand live components', async () => {
  assert.equal(docsSource.getPage(['index']), undefined)
  assert.equal(getDocsMarkdown('/docs/index'), undefined)
  assert.equal(getDocsMarkdown('/docs//automate'), undefined)
  assert.equal(getDocsMarkdown('/pricing'), undefined)

  for (const page of pages) {
    const md = getDocsMarkdown(page.url)
    assert.ok(md, `Missing markdown for ${page.url}`)
    assert.ok(md.content.startsWith(`# ${page.data.title}`))
    assert.doesNotMatch(md.content, /<(ApiKeyScopesTable|McpToolsTable|McpClientsList)\s*\/>/)
  }

  const scopesMd = getDocsMarkdown('/docs/reference/api-scopes')!
  for (const scope of apiKeyScopes) {
    assert.ok(
      scopesMd.content.includes(scope),
      `Markdown /docs/reference/api-scopes missing ${scope}`
    )
  }

  const subDocRes = agentMarkdownResponse('/docs/features/signed-in-capture')
  assert.equal(subDocRes.status, 200)
  assert.match(subDocRes.headers.get('content-type') ?? '', /text\/markdown/)
  assert.match(subDocRes.headers.get('link') ?? '', /rel="canonical"/)
  assert.match(await subDocRes.text(), /^# Signed-In & Autonomous AI Capture/)

  const localizedRes = agentMarkdownResponse('/fr/docs/automate')
  assert.equal(localizedRes.status, 200)
  assert.match(await localizedRes.text(), /^# Automate Your Launches/)

  const missingRes = agentMarkdownResponse('/docs/index')
  assert.equal(missingRes.status, 404)
})

test('sitemap includes every published docs URL once without duplicates', () => {
  const entries = sitemap()
  const urls = entries.map((entry) => entry.url)
  assert.equal(new Set(urls).size, urls.length, 'sitemap contains duplicate URLs')

  for (const doc of getDocsPageEntries()) {
    assert.ok(
      urls.some((url) => url.endsWith(doc.url)),
      `sitemap missing docs URL ${doc.url}`
    )
  }
})

test('generateMetadata sets canonicals, titles, and noindex for unknown slugs', async () => {
  const rootMeta = await generateMetadata({ params: Promise.resolve({ locale: 'en' }) })
  assert.deepEqual(rootMeta.title, { absolute: 'Shots Documentation' })
  assert.equal(rootMeta.alternates?.canonical, '/docs')

  const authMeta = await generateMetadata({
    params: Promise.resolve({ locale: 'en', slug: ['authentication'] }),
  })
  assert.deepEqual(authMeta.title, { absolute: 'Shots API Authentication | Shots Docs' })
  assert.equal(authMeta.alternates?.canonical, '/docs/authentication')

  const missingMeta = await generateMetadata({
    params: Promise.resolve({ locale: 'en', slug: ['nonexistent-slug'] }),
  })
  assert.deepEqual(missingMeta.robots, { follow: false, index: false })
})

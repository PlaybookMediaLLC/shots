import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { SETTINGS_SECTIONS } from '../components/workspace/settings-sections'
import { openApiSpec } from '../lib/api/openapi'
import { getDocsPageEntries } from '../lib/docs/source'
import { PLATFORM_DESTINATIONS } from '../lib/platform/navigation'

const DOCS_DIR = path.join(process.cwd(), 'content/docs')
const BOLD_SETTINGS_LABEL_PATTERN = /\*\*Settings\s*(?:→|->)\s*([^*]+)\*\*/g
const ASCII_SETTINGS_ARROW_PATTERN = /Settings\s*->\s*[^\n]+/g
const BACKTICKED_API_OP_PATTERN = /`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[^`\s*]+)`/g

const NAVIGATION_COVERAGE = new Map<string, string>([
  ['home', '/docs/features/home'],
  ['create', '/docs/features/create'],
  ['campaigns', '/docs/features/campaigns'],
  ['publish', '/docs/features/publish'],
  ['library', '/docs/features/library'],
  ['automate', '/docs/features/automate-workflows'],
  ['activity', '/docs/features/activity'],
  ['settings', '/docs/features/settings-workspace'],
])

const SETTINGS_COVERAGE = new Map<string, string>([
  ['founder-hub', '/docs/features/settings-workspace'],
  ['profile', '/docs/features/settings-workspace'],
  ['notifications', '/docs/features/settings-workspace'],
  ['appearance', '/docs/features/settings-workspace'],
  ['security', '/docs/features/settings-workspace'],
  ['install', '/docs/features/settings-workspace'],
  ['general', '/docs/features/settings-workspace'],
  ['billing', '/docs/features/settings-workspace'],
  ['members', '/docs/features/settings-workspace'],
  ['roles', '/docs/features/settings-workspace'],
  ['voice', '/docs/features/settings-workspace'],
  ['new-team', '/docs/getting-started/workspace-setup'],
  ['ai-models', '/docs/features/settings-workspace'],
  ['ai-instructions', '/docs/features/settings-workspace'],
  ['brand', '/docs/features/settings-brand'],
  ['product', '/docs/features/settings-brand'],
  ['surfaces', '/docs/features/settings-brand'],
  ['sharing', '/docs/features/settings-brand'],
  ['social-sets', '/docs/features/settings-publishing'],
  ['channels', '/docs/features/settings-publishing'],
  ['integrations', '/docs/features/settings-publishing'],
  ['agents', '/docs/features/settings-publishing'],
  ['sso', '/docs/features/settings-enterprise'],
  ['permission-groups', '/docs/features/settings-enterprise'],
  ['whitelabel', '/docs/features/settings-enterprise'],
  ['audit', '/docs/features/settings-enterprise'],
  ['api', '/docs/features/settings-enterprise'],
  ['experimental', '/docs/features/settings-workspace'],
])

const listMdxFiles = (dir: string): string[] => {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listMdxFiles(fullPath))
    } else if (entry.name.endsWith('.mdx')) {
      files.push(fullPath)
    }
  }
  return files
}

test('maps every primary platform destination to a published docs page', () => {
  const publishedUrls = new Set(getDocsPageEntries().map((entry) => entry.url))
  const unmapped = PLATFORM_DESTINATIONS.filter((item) => !NAVIGATION_COVERAGE.has(item.key)).map(
    (item) => item.key
  )
  const missing = [...NAVIGATION_COVERAGE.values()].filter((url) => !publishedUrls.has(url))

  assert.deepEqual(unmapped, [])
  assert.deepEqual(missing, [])
})

test('maps every settings section to a published docs page', () => {
  const publishedUrls = new Set(getDocsPageEntries().map((entry) => entry.url))
  const unmapped = SETTINGS_SECTIONS.filter((section) => !SETTINGS_COVERAGE.has(section.id)).map(
    (section) => section.id
  )
  const missing = [...SETTINGS_COVERAGE.values()].filter((url) => !publishedUrls.has(url))

  assert.deepEqual(unmapped, [])
  assert.deepEqual(missing, [])
})

test('uses only real Settings labels and canonical Unicode arrows in MDX instructions', () => {
  const validTitles = new Set(SETTINGS_SECTIONS.map((section) => section.title))
  const failures: string[] = []

  for (const filePath of listMdxFiles(DOCS_DIR)) {
    const content = fs.readFileSync(filePath, 'utf8')
    const rel = path.relative(DOCS_DIR, filePath)

    for (const match of content.matchAll(ASCII_SETTINGS_ARROW_PATTERN)) {
      failures.push(`${rel}: use → instead of -> in "${match[0]}"`)
    }
    for (const match of content.matchAll(BOLD_SETTINGS_LABEL_PATTERN)) {
      const label = match[1]!.trim()
      if (!validTitles.has(label)) {
        failures.push(`${rel}: Settings → ${label}`)
      }
    }
  }

  assert.deepEqual(failures, [])
})

test('every documented HTTP method + /api path exists in the live OpenAPI spec', () => {
  const paths = openApiSpec.paths as Record<string, Record<string, unknown>>
  const failures: string[] = []

  for (const filePath of listMdxFiles(DOCS_DIR)) {
    const content = fs.readFileSync(filePath, 'utf8')
    const rel = path.relative(DOCS_DIR, filePath)

    for (const match of content.matchAll(BACKTICKED_API_OP_PATTERN)) {
      const method = match[1]!.toLowerCase()
      const apiPath = match[2]!
      const specItem = paths[apiPath]
      if (!specItem || !(method in specItem)) {
        failures.push(`${rel}: ${match[1]} ${apiPath} not found in openApiSpec.paths`)
      }
    }
  }

  assert.deepEqual(failures, [])
})

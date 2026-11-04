import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

/**
 * The vendored editor is a library (RFC 013). It reaches nothing the app owns:
 * no app module, no environment variable, no route of ours, no upload vendor.
 * Uploads, AI and collaboration arrive through `EditorServicesProvider` and
 * the collaboration config, so this scan keeps a coupling from creeping back
 * in with a later pull from oppulence-canvas.
 */

const ROOT = join(process.cwd(), '../../packages/platejs-editor')
const SOURCE = join(ROOT, 'src')
const FORBIDDEN = [
  { pattern: /from ['"]@\//, reason: 'imports from the app' },
  { pattern: /import\(['"]@\//, reason: 'imports from the app' },
  { pattern: /process\.env/, reason: 'reads process.env' },
  { pattern: /['"`]\/api\//, reason: 'hard-codes an /api route' },
  { pattern: /uploadthing/, reason: 'depends on uploadthing' },
]

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs)$/.test(entry) ? [path] : []
  })
}

test('the editor package imports nothing from the app and reads no environment', () => {
  const files = sourceFiles(SOURCE)
  assert.ok(files.length > 200, `expected the vendored sources, found ${files.length}`)
  const problems = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8')
    return FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
      ({ reason }) => `${relative(process.cwd(), file)} ${reason}`
    )
  })
  assert.deepEqual(problems, [])
})

test('the editor package declares no upload vendor dependency', () => {
  const manifest = readFileSync(join(ROOT, 'package.json'), 'utf8')
  assert.doesNotMatch(manifest, /uploadthing/)
})

test('the boundary scan catches each forbidden coupling', () => {
  const samples = [
    "import { db } from '@/lib/db'",
    'const key = process.env.SECRET',
    "fetch('/api/ai/command')",
    "import { generateReactHelpers } from '@uploadthing/react'",
  ]
  for (const sample of samples) {
    assert.ok(
      FORBIDDEN.some(({ pattern }) => pattern.test(sample)),
      `not caught: ${sample}`
    )
  }
})

/**
 * The post editor looks like the app (the post editor brief): its controls and
 * surfaces use the app's tokens, so a theme or accent change reaches them.
 * Raw hex colors, pixel font sizes, square or off-scale radii, and text
 * glyphs drawn as icons fail here. A code block's syntax colors, the
 * YouTube embed's own play button and platform previews are content, not chrome.
 */
const STYLED = [
  join(SOURCE, 'ui'),
  join(process.cwd(), 'components/drafts'),
  join(process.cwd(), 'components/write/composer'),
]
const CONTENT_COLORS = new Set([
  'code-block-node.tsx',
  'code-block-node-static.tsx',
  'media-video-node.tsx',
  // Previews copy each platform's own type (X's 15px), not the app's.
  'preview.tsx',
  'SharedDraftView.tsx',
])
const OFF_TOKEN = [
  { pattern: /-\[#[0-9a-fA-F]{3,8}\b/, reason: 'uses a raw hex color' },
  { pattern: /\btext-\[\d+(\.\d+)?px\]/, reason: 'uses a raw pixel font size' },
  { pattern: /\brounded-(none\b|\[[^\]]+\])/, reason: 'uses a radius outside the scale' },
  { pattern: />\s*[☺⋯▾▸✕×]\s*</, reason: 'draws an icon with a text glyph' },
]

test('the post editor uses the app’s tokens and Phosphor icons only', () => {
  const problems = STYLED.flatMap(sourceFiles)
    .filter((file) => file.endsWith('.tsx') && !CONTENT_COLORS.has(file.split('/').pop() ?? ''))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return OFF_TOKEN.filter(({ pattern }) => pattern.test(source)).map(
        ({ reason }) => `${relative(process.cwd(), file)} ${reason}`
      )
    })
  assert.deepEqual(problems, [])
})

test('the token scan catches each off-token style', () => {
  const samples = [
    '<div className="bg-[#212121]" />',
    '<span className="text-[11px]" />',
    '<div className="rounded-none" />',
    '<div className="rounded-[14.4px]" />',
    '<Button>⋯</Button>',
  ]
  for (const sample of samples) {
    assert.ok(
      OFF_TOKEN.some(({ pattern }) => pattern.test(sample)),
      `not caught: ${sample}`
    )
  }
})

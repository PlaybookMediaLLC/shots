import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'

/**
 * The root layout's title template appends "| Shots", so a page
 * title that already names the brand renders it twice in the browser tab.
 * Pages that need the full string set `title: { absolute: ... }` instead.
 * A nested Open Graph title skips the template, so it may name the brand.
 */

const ROOT = process.cwd()

function pageFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory)).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(join(ROOT, path)).isDirectory()) return pageFiles(path)
    return /^(page|layout)\.tsx$/.test(entry) ? [relative(ROOT, join(ROOT, path))] : []
  })
}

function brandedTitles(source: string): string[] {
  const patterns = [
    /title:\s*(['"`])([^'"`]*\| Shots)\1/g,
    /^ {2}title:\s*(['"`])([^'"`]*\bShots\b[^'"`]*)\1/gm,
  ]
  const titles = patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[2])
  )
  return [...new Set(titles)]
}

test('page titles do not repeat the brand the layout template adds', () => {
  const files = pageFiles('app/[locale]')
  assert.ok(files.length > 20, 'the page scan found too few files to be meaningful')
  const offenders = files.flatMap((file) =>
    brandedTitles(readFileSync(join(ROOT, file), 'utf8')).map((title) => `${file}: ${title}`)
  )
  assert.deepEqual(offenders, [])
})

test('the title scan detects a doubled brand and allows absolute titles', () => {
  assert.deepEqual(brandedTitles("export const metadata = { title: 'Assets | Shots' }"), [
    'Assets | Shots',
  ])
  assert.deepEqual(brandedTitles("{ title: { absolute: 'Campaign | Shots' } }"), [])
  assert.deepEqual(brandedTitles("{ title: 'Assets' }"), [])
  assert.deepEqual(
    brandedTitles('export const metadata = {\n  title: "Shots API Documentation",\n}'),
    ['Shots API Documentation']
  )
  assert.deepEqual(brandedTitles("  openGraph: {\n    title: 'Features - Shots',\n  },"), [])
  assert.deepEqual(brandedTitles("  return {\n    title: 'Library | Shots',\n  }"), [
    'Library | Shots',
  ])
})

test('pages do not offer Shots for free: there is no free plan', () => {
  const claims =
    /isAccessibleForFree|price:\s*['"]0['"]|title:\s*['"`][^'"`]*\bfree\b|question:[^\n]*\bfree\b|sign up free|free with|for free/i
  const offenders = pageFiles('app/[locale]').filter((file) =>
    claims.test(readFileSync(join(ROOT, file), 'utf8'))
  )
  assert.deepEqual(offenders, [])
})

test('pages with Open Graph data keep a share image: the root layout sets none for X', () => {
  const offenders = pageFiles('app/[locale]').filter((file) => {
    const source = readFileSync(join(ROOT, file), 'utf8')
    return /^\s*openGraph:/m.test(source) && !/OG_DEFAULTS|images:|twitter:/.test(source)
  })
  assert.deepEqual(offenders, [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'
import nextConfig from '../next.config'

test('Home and the editor are not cross-origin isolated, so their render frame can load', async () => {
  const rules = (await nextConfig.headers?.()) ?? []
  const isolating = rules.filter(
    (rule) =>
      ['/home', '/editor', '/editor/:path*'].includes(rule.source) &&
      rule.headers.some((header) => header.key === 'Cross-Origin-Embedder-Policy')
  )
  assert.deepEqual(isolating, [])
})

test('API Cache-Control default keeps private no-store for API routes without clobbering asset content revalidation', async () => {
  const rules = (await nextConfig.headers?.()) ?? []
  const cacheRules = rules.filter((rule) =>
    rule.headers.some((header) => header.key.toLowerCase() === 'cache-control')
  )
  const matchingAssetContent = cacheRules.filter(
    (rule) => getPathMatch(rule.source)('/api/v1/assets/asset-123/content') !== false
  )
  assert.deepEqual(matchingAssetContent, [])

  const apiNoStore = cacheRules.filter((rule) =>
    rule.headers.some(
      (header) => header.key === 'Cache-Control' && header.value === 'private, no-store'
    )
  )
  assert.ok(apiNoStore.length > 0, 'expected a private, no-store Cache-Control rule for API routes')
  for (const path of [
    '/api/health',
    '/api/v1/assets/asset-123/download-url',
    '/api/v1/assets/asset-123/content/extra',
  ]) {
    assert.ok(
      apiNoStore.some((rule) => getPathMatch(rule.source)(path) !== false),
      `expected private, no-store Cache-Control rule to match ${path}`
    )
  }
})

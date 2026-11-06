import assert from 'node:assert/strict'
import { test } from 'node:test'
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

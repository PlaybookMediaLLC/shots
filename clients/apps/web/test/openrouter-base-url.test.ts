import assert from 'node:assert/strict'
import test from 'node:test'
import { openRouterBaseURL } from '@/lib/ai/models/provider'

test('a deployment ignores the provider override; the loopback test stack may use it', (t) => {
  const env = { ...process.env }
  t.after(() => {
    process.env = env
  })
  Object.assign(process.env, {
    BETTER_AUTH_URL: 'https://shots.example.com',
    NODE_ENV: 'production',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:4014/api/v1',
    PLATFORM_E2E_HOOKS: '1',
  })
  assert.equal(openRouterBaseURL(), undefined)
  Object.assign(process.env, { BETTER_AUTH_URL: 'http://localhost:3000' })
  assert.equal(openRouterBaseURL(), 'http://127.0.0.1:4014/api/v1')
})

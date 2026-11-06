import assert from 'node:assert/strict'
import test from 'node:test'
import { testHooksAllowed } from '@/lib/e2e-hooks'

const env = process.env as Record<string, string | undefined>

function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    previous[key] = env[key]
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
}

test('a development or test build always has its hooks', () => {
  withEnv(
    { NODE_ENV: 'development', PLATFORM_E2E_HOOKS: undefined, BETTER_AUTH_URL: undefined },
    () => assert.equal(testHooksAllowed(), true)
  )
})

test('a production build has no hooks until it is asked for them', () => {
  withEnv(
    {
      NODE_ENV: 'production',
      PLATFORM_E2E_HOOKS: undefined,
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
    () => assert.equal(testHooksAllowed(), false)
  )
})

test('a production build serving an end-to-end stack has its hooks', () => {
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:3010', 'http://[::1]:3000']) {
    withEnv({ NODE_ENV: 'production', PLATFORM_E2E_HOOKS: '1', BETTER_AUTH_URL: url }, () =>
      assert.equal(testHooksAllowed(), true, url)
    )
  }
})

// The reason the variable is safe to add to the e2e Compose overlay: on a
// deployed origin it enables nothing, however it reaches the process.
test('a deployed production build has no hooks even with the variable set', () => {
  for (const url of [
    'https://shots.playbookmedia.io',
    'https://localhost.attacker.example',
    'not-a-url',
    undefined,
  ]) {
    withEnv(
      {
        NODE_ENV: 'production',
        PLATFORM_E2E_HOOKS: '1',
        BETTER_AUTH_URL: url,
        NEXT_PUBLIC_APP_URL: undefined,
      },
      () => assert.equal(testHooksAllowed(), false, String(url))
    )
  }
})

test('the screenshot mock host is reachable only while the hooks are allowed', async () => {
  const { allowedTestHosts } = await import('@/lib/launch/safe-fetch')
  withEnv(
    {
      NODE_ENV: 'production',
      PLATFORM_E2E_HOOKS: undefined,
      BETTER_AUTH_URL: 'https://shots.playbookmedia.io',
      SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS: 'screenshot-mock',
    },
    () => assert.deepEqual([...allowedTestHosts()], [])
  )
  withEnv(
    {
      NODE_ENV: 'production',
      PLATFORM_E2E_HOOKS: '1',
      BETTER_AUTH_URL: 'http://localhost:3000',
      SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS: 'screenshot-mock',
    },
    () => assert.deepEqual([...allowedTestHosts()], ['screenshot-mock'])
  )
})

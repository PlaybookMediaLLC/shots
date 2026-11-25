import assert from 'node:assert/strict'
import test from 'node:test'

test('the browser start accepts an older sign-in than other sensitive actions', async (t) => {
  process.env.PUBLISHING_API_URL = 'http://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'backend-token'
  process.env.SHOTS_AUTH_SERVICE_TOKEN = 'auth-service-token-for-the-sign-in-age-test'
  const { auth } = await import('@/lib/auth/server')
  const { requireSensitiveActiveOrganizationPermission } = await import('@/lib/auth/access')
  const { startSocialOAuth } = await import('@/lib/tenant/social-oauth-start')
  let age = 20
  const api = auth.api as unknown as { getSession: () => Promise<unknown> }
  t.mock.method(api, 'getSession', async () => ({
    session: {
      activeOrganizationId: 'org_age',
      createdAt: new Date(Date.now() - age * 60_000),
      id: 'session_age',
    },
    user: { email: 'age@example.test', id: 'user_age', twoFactorEnabled: true },
  }))
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    paths.push(path)
    if (path === '/v1/access')
      return Response.json({ deniedPermissions: [], organizationId: 'org_age', role: 'owner' })
    return Response.json({ error: 'stop here' }, { status: 500 })
  })
  const tooOld = /A fresh sign-in is required/

  await assert.rejects(
    requireSensitiveActiveOrganizationPermission(new Headers(), 'connection:manage'),
    tooOld
  )
  // The start passes the sign-in check and reaches the backend, which this test fails.
  await assert.rejects(startSocialOAuth(new Headers(), 'x'), (error: Error) => {
    return !tooOld.test(error.message)
  })
  assert.ok(paths.some((path) => path.includes('social-oauth')))
  age = 25 * 60
  await assert.rejects(startSocialOAuth(new Headers(), 'x'), tooOld)
})

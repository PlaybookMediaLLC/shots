import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src/index'
import { socialOAuthBeginRequestSchema } from '../../../packages/screenshot-studio-backend-sdk/src/social-oauth'

test('first connection requires explicit ownership and cannot mix creation with reconnect', () => {
  assert.equal(
    socialOAuthBeginRequestSchema.safeParse({ provider: 'x', operation: 'CREATE_SET' }).success,
    false
  )
  for (const creationVisibility of ['PRIVATE', 'WORKSPACE']) {
    const valid = { provider: 'x', operation: 'CREATE_SET', creationVisibility }
    assert.equal(socialOAuthBeginRequestSchema.safeParse(valid).success, true)
    assert.equal(
      socialOAuthBeginRequestSchema.safeParse({ ...valid, socialSetId: 'existing' }).success,
      false
    )
    assert.equal(
      socialOAuthBeginRequestSchema.safeParse({ ...valid, expectedConnectionId: 'existing' })
        .success,
      false
    )
  }
  assert.equal(
    socialOAuthBeginRequestSchema.safeParse({ provider: 'x', operation: 'RECONNECT' }).success,
    false
  )
  assert.equal(
    socialOAuthBeginRequestSchema.safeParse({
      provider: 'x',
      operation: 'ADD_ACCOUNT',
      creationVisibility: 'PRIVATE',
    }).success,
    false
  )
})

test('first connection carries its immutable private owner context to the backend', async () => {
  const client = new ScreenshotStudioBackendSDK(
    'https://backend.test',
    'fixture-service',
    {
      organizationId: 'original-workspace',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
    },
    async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        provider: 'x',
        operation: 'CREATE_SET',
        creationVisibility: 'PRIVATE',
      })
      return Response.json({ url: 'https://api.x.com/oauth/authorize?oauth_token=fixture' })
    }
  )
  await client.beginSocialOAuth('x', undefined, {
    operation: 'CREATE_SET',
    creationVisibility: 'PRIVATE',
  })
})

test('OAuth begin sends the exact reconnect target and attempt return path', async () => {
  const client = new ScreenshotStudioBackendSDK(
    'https://backend.test',
    'fixture-service',
    {
      organizationId: 'original-workspace',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
    },
    async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('x-organization-id'), 'original-workspace')
      assert.deepEqual(JSON.parse(String(init?.body)), {
        provider: 'x',
        socialSetId: 'originalset1234',
        expectedConnectionId: 'original-connection',
        returnPath: '/settings/publishing-brands/originalset1234',
      })
      return Response.json({ url: 'https://api.x.com/oauth/authorize?oauth_token=fixture' })
    }
  )
  await client.beginSocialOAuth('x', 'originalset1234', {
    expectedConnectionId: 'original-connection',
    returnPath: '/settings/publishing-brands/originalset1234',
  })
})

test('OAuth context accepts only the backend validated local return destination', async () => {
  const client = new ScreenshotStudioBackendSDK(
    'https://backend.test',
    'fixture-service',
    {
      organizationId: '',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
    },
    async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('x-session-id'), 'session')
      return Response.json({
        organizationId: 'original-workspace',
        socialSetId: null,
        returnPath: 'https://elsewhere.test',
      })
    }
  )
  await assert.rejects(client.resolveSocialOAuthContext('x', 'state'))
})

test('custom Mastodon requires a safe server and carries it with the original creation intent', async () => {
  const valid = {
    provider: 'mastodon-custom',
    operation: 'CREATE_SET',
    creationVisibility: 'PRIVATE',
    instanceServer: 'example.social',
  }
  assert.equal(socialOAuthBeginRequestSchema.safeParse(valid).success, true)
  for (const instanceServer of [
    undefined,
    '',
    'http://example.social',
    'https://127.0.0.1',
    'https://user:secret@example.social',
    'https://example.social:443',
  ])
    assert.equal(
      socialOAuthBeginRequestSchema.safeParse({ ...valid, instanceServer }).success,
      false
    )
  assert.equal(socialOAuthBeginRequestSchema.safeParse({ ...valid, provider: 'x' }).success, false)
  const client = new ScreenshotStudioBackendSDK(
    'https://backend.test',
    'fixture-service',
    {
      organizationId: 'original-workspace',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
    },
    async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), valid)
      return Response.json({ url: 'https://example.social/oauth/authorize?state=fixture' })
    }
  )
  await client.beginSocialOAuth('mastodon-custom', undefined, {
    operation: 'CREATE_SET',
    creationVisibility: 'PRIVATE',
    instanceServer: 'example.social',
  })
})

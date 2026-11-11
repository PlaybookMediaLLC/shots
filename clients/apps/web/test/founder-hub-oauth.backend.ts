import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { z } from 'zod'
import { getTotpCode } from './e2e/framework/totp'
import {
  founderHubSettingsSchema,
  founderHubSettingsProfileSchema,
} from 'screenshot-studio-backend-sdk'

test('Founder Hub PKCE, rotation, identity, and revocation use the real Shots backend', async (t) => {
  process.env.PUBLISHING_API_URL = z.url().parse(process.env.FOUNDER_HUB_TEST_API_URL)
  const { auth } = await import('../lib/auth/server')
  const { requireFounderHubAccess } = await import('../lib/auth/founder-hub')
  const { serviceBackend } = await import('../lib/backend/sdk')
  const serviceToken = z.string().min(32).parse(process.env.SHOTS_AUTH_SERVICE_TOKEN)
  const accessHeaders = (token: string) =>
    new Headers({
      authorization: `Bearer ${token}`,
      'x-shots-founder-hub-service': serviceToken,
    })
  const origin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
  const email = `founder-hub-${randomUUID()}@example.test`
  const password = randomBytes(24).toString('base64url')
  const signup = await auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password, name: 'Founder Hub integration' }),
    })
  )
  assert.equal(signup.status, 200)
  const user = z.object({ user: z.object({ id: z.string() }) }).parse(await signup.json()).user
  t.after(async () => {
    const signin = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email, password }),
      })
    )
    assert.equal(signin.status, 200)
    let cookie = signin.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const withoutFactor = await fetch(`${origin}/api/v1/me/account-deletion`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: email }),
    })
    assert.equal(withoutFactor.status, 403, 'account deletion still requires the second factor')
    const enabled = await auth.handler(
      new Request(`${origin}/api/auth/two-factor/enable`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    )
    assert.equal(enabled.status, 200)
    const setup = z.object({ totpURI: z.string() }).parse(await enabled.json())
    const verified = await auth.handler(
      new Request(`${origin}/api/auth/two-factor/verify-totp`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ code: getTotpCode(setup.totpURI) }),
      })
    )
    assert.equal(verified.status, 200)
    const refreshedCookies = verified.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    if (refreshedCookies) cookie = refreshedCookies
    const cleanup = await fetch(`${origin}/api/v1/me/account-deletion`, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: email }),
    })
    assert.equal(cleanup.status, 202, 'fixture cleanup uses the durable account-deletion owner')
    const { accountDeletionStatusSchema } = await import('../lib/api/contracts/settings-platform')
    assert.equal(
      accountDeletionStatusSchema.parse(await cleanup.json()).request?.status,
      'REQUESTED'
    )
  })
  const cookie = signup.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  assert.ok(cookie)
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectURI = 'anarlog-dev://auth/callback'
  const state = randomUUID()
  const authorize = async (sessionCookie = cookie) => {
    const query = new URLSearchParams({
      client_id: 'shots-founder-hub',
      response_type: 'code',
      redirect_uri: redirectURI,
      scope: 'openid profile email offline_access founder-hub',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    const response = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/authorize?${query}`, {
        headers: { cookie: sessionCookie, accept: 'application/json' },
      })
    )
    assert.equal(response.status, 200)
    const target = new URL(z.object({ url: z.string() }).parse(await response.json()).url)
    assert.equal(target.searchParams.get('state'), state)
    assert.ok(target.searchParams.get('code'))
    assert.equal(target.searchParams.get('iss'), `${origin}/api/auth`)
    return target.searchParams.get('code')!
  }
  const exchange = (body: Record<string, string>) =>
    auth.handler(
      new Request(`${origin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'shots-founder-hub',
          resource: `${origin}/api/founder-hub`,
          ...body,
        }),
      })
    )
  const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string() })
  const code = await authorize()
  const grant = {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectURI,
  }
  const issued = await exchange(grant)
  assert.equal(issued.status, 200)
  const tokens = tokenSchema.parse(await issued.json())
  assert.equal((await exchange(grant)).status, 401, 'authorization codes are single-use')
  const wrongPKCE = await exchange({
    ...grant,
    code: await authorize(),
    code_verifier: randomBytes(32).toString('base64url'),
  })
  assert.equal(wrongPKCE.status, 401)
  await assert.rejects(
    requireFounderHubAccess(new Headers({ authorization: `Bearer ${tokens.access_token}` })),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 403
  )
  await assert.rejects(
    requireFounderHubAccess(
      new Headers({
        authorization: `Bearer ${tokens.access_token}`,
        'x-shots-founder-hub-service': randomBytes(32).toString('hex'),
      })
    ),
    (error: unknown) => error instanceof Error && 'status' in error && error.status === 403
  )
  const headers = accessHeaders(tokens.access_token)
  const readSettings = async () =>
    founderHubSettingsSchema.parse(
      await (await fetch(`${origin}/api/founder-hub/settings`, { headers: { cookie } })).json()
    )
  const catalog = (await readSettings()).catalog
  const nativeValues: Record<string, unknown> = {
    lock_app: false,
    export_directory: '/tmp/exports',
    automation_markdown_export_directory: '/tmp/automation-exports',
    local_stt_model_path: '/tmp/test-model',
    automation_workflows: '[]',
    ...Object.fromEntries(
      Object.entries(catalog)
        .filter(([, definition]) => definition.readOnly)
        .map(([key]) => [key, null])
    ),
  }
  let version = 0
  for (const [key, value] of Object.entries(nativeValues)) {
    const before = (await readSettings()).profiles
    const body = JSON.stringify({
      deviceId: 'boundary-test',
      deviceName: 'Test desktop',
      baseVersion: version,
      values: { [key]: value },
    })
    const denied = await fetch(`${origin}/api/founder-hub/settings`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json', 'x-shots-founder-hub-native': 'true' },
      body,
    })
    assert.equal(denied.status, 403, `${key} requires native authority even with a forged header`)
    assert.deepEqual(
      (await readSettings()).profiles,
      before,
      `${key} changed the stored version or value`
    )
    const nativeHeaders = new Headers(headers)
    nativeHeaders.set('content-type', 'application/json')
    const saved = await fetch(`${origin}/api/founder-hub/settings`, {
      method: 'PATCH',
      headers: nativeHeaders,
      body,
    })
    assert.equal(saved.status, 200, `${key} should synchronize from the native app`)
    version = founderHubSettingsProfileSchema.parse(await saved.json()).version
  }
  const reset = await fetch(`${origin}/api/founder-hub/settings`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'boundary-test',
      deviceName: 'Test desktop',
      baseVersion: version,
      values: { export_directory: '' },
    }),
  })
  assert.equal(reset.status, 200, 'the browser can reset a chosen export folder')
  const first = await requireFounderHubAccess(headers)
  assert.equal(first.user.id, user.id)
  assert.equal((await requireFounderHubAccess(headers)).accountUserId, first.accountUserId)
  const refreshed = await exchange({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  })
  assert.equal(refreshed.status, 200)
  const rotated = tokenSchema.parse(await refreshed.json())
  assert.notEqual(rotated.refresh_token, tokens.refresh_token)
  assert.equal(
    (await requireFounderHubAccess(accessHeaders(rotated.access_token))).accountUserId,
    first.accountUserId
  )
  const gateway = z.url().parse(process.env.FOUNDER_HUB_GATEWAY_URL)
  let gatewayRefresh: string | undefined
  {
    const exchange = await fetch(`${gateway}/auth/v1/token?grant_type=authorization_code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: await authorize(),
        code_verifier: verifier,
        redirect_uri: redirectURI,
      }),
    })
    assert.equal(exchange.status, 200)
    const installed = tokenSchema
      .extend({ user: z.object({ id: z.uuid() }) })
      .parse(await exchange.json())
    assert.equal(installed.user.id, first.accountUserId)
    const gatewayHeaders = { authorization: `Bearer ${installed.access_token}` }
    const currentUser = await fetch(`${gateway}/auth/v1/user`, { headers: gatewayHeaders })
    assert.equal(currentUser.status, 200)
    assert.equal(z.object({ id: z.uuid() }).parse(await currentUser.json()).id, first.accountUserId)
    const workspaces = await fetch(`${gateway}/rest/v1/workspaces?select=id,kind`, {
      headers: gatewayHeaders,
    })
    assert.equal(workspaces.status, 200, await workspaces.clone().text())
    assert.deepEqual(
      z.array(z.object({ id: z.uuid(), kind: z.string() })).parse(await workspaces.json()),
      [{ id: first.accountUserId, kind: 'personal' }]
    )
    const object = `${first.accountUserId}/integration.png`
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZ8AAAAASUVORK5CYII=',
      'base64'
    )
    const uploaded = await fetch(`${gateway}/storage/v1/object/profile-avatars/${object}`, {
      method: 'POST',
      headers: { ...gatewayHeaders, 'content-type': 'image/png' },
      body: png,
    })
    assert.equal(uploaded.status, 200, await uploaded.clone().text())
    const downloaded = await fetch(
      `${gateway}/storage/v1/object/authenticated/profile-avatars/${object}`,
      { headers: gatewayHeaders }
    )
    assert.equal(downloaded.status, 200)
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png)
    const tusObject = `${first.accountUserId}/resumed.png`
    const tusHeaders = { ...gatewayHeaders, 'tus-resumable': '1.0.0' }
    const created = await fetch(`${gateway}/storage/v1/upload/resumable`, {
      method: 'POST',
      headers: {
        ...tusHeaders,
        'upload-length': String(png.length),
        'upload-metadata': Object.entries({
          bucketName: 'profile-avatars',
          objectName: tusObject,
          contentType: 'image/png',
        })
          .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
          .join(','),
      },
    })
    assert.equal(created.status, 201, await created.clone().text())
    const location = created.headers.get('location')
    assert.ok(location && location.startsWith('/cloud/storage/v1/upload/resumable/'))
    const resumeUrl = new URL(location, gateway).toString()
    const head = await fetch(resumeUrl, { method: 'HEAD', headers: tusHeaders })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('upload-offset'), '0')
    const patched = await fetch(resumeUrl, {
      method: 'PATCH',
      headers: {
        ...tusHeaders,
        'upload-offset': '0',
        'content-type': 'application/offset+octet-stream',
      },
      body: png,
    })
    assert.equal(patched.status, 204, await patched.clone().text())
    const resumed = await fetch(
      `${gateway}/storage/v1/object/authenticated/profile-avatars/${tusObject}`,
      { headers: gatewayHeaders }
    )
    assert.equal(resumed.status, 200)
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), png)
    const foreign = await fetch(
      `${gateway}/storage/v1/object/profile-avatars/${randomUUID()}/integration.png`,
      {
        method: 'POST',
        headers: { ...gatewayHeaders, 'content-type': 'image/png' },
        body: png,
      }
    )
    assert.ok(!foreign.ok, 'another account cannot receive this upload')
    assert.equal(
      (
        await fetch(`${gateway}/rest/v1/rpc/project_shots_authority`, {
          method: 'POST',
          headers: { ...gatewayHeaders, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403
    )
    assert.equal(
      (
        await fetch(`${gateway}/storage/v1/object/profile-avatars`, {
          method: 'DELETE',
          headers: { ...gatewayHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ prefixes: [object, tusObject] }),
        })
      ).status,
      200
    )
    const refreshed = await fetch(`${gateway}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: installed.refresh_token }),
    })
    assert.equal(refreshed.status, 200)
    gatewayRefresh = tokenSchema.parse(await refreshed.json()).refresh_token
  }
  const otherLogin = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email, password }),
    })
  )
  assert.equal(otherLogin.status, 200)
  const otherCookie = otherLogin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const otherIssued = await exchange({ ...grant, code: await authorize(otherCookie) })
  assert.equal(otherIssued.status, 200)
  const otherTokens = tokenSchema.parse(await otherIssued.json())
  const otherRefresh = { grant_type: 'refresh_token', refresh_token: otherTokens.refresh_token }
  const otherRotatedResponse = await exchange(otherRefresh)
  assert.equal(otherRotatedResponse.status, 200)
  const otherRotated = tokenSchema.parse(await otherRotatedResponse.json())
  await serviceBackend().authStore({
    model: 'verification',
    op: 'update',
    where: [
      {
        field: 'id',
        value: `founder-hub-refresh:${createHash('sha256').update(otherTokens.refresh_token).digest('base64url')}`,
      },
    ],
    data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
  })
  assert.equal(
    (await exchange(otherRefresh)).status,
    400,
    'reuse beyond the grace period is rejected'
  )
  await assert.rejects(requireFounderHubAccess(accessHeaders(otherRotated.access_token)), {
    status: 401,
  })
  await requireFounderHubAccess(headers)
  await serviceBackend().authStore({
    model: 'session',
    op: 'delete',
    where: [{ field: 'id', value: first.sessionId }],
  })
  await assert.rejects(requireFounderHubAccess(headers), (error: unknown) => {
    return typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  })
  assert.equal(
    (await exchange({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token })).status,
    400
  )
  {
    assert.equal((await fetch(`${gateway}/rest/v1/workspaces`, { headers })).status, 401)
    assert.equal(
      (
        await fetch(`${gateway}/auth/v1/token?grant_type=refresh_token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: gatewayRefresh }),
        })
      ).status,
      400
    )
  }
})

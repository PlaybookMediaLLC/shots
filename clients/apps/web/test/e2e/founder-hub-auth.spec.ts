import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { founderHubAccessSchema } from '../../lib/api/contracts/founder-hub'
import {
  createWorkspace,
  db,
  expect,
  getActiveOrganizationId,
  getE2EUrl,
  grantWorkspacePlan,
  startHttpMockServer,
  test,
} from './framework'

test('Founder Hub signs in through Shots and loses access on sign-out', async ({
  app,
  identity,
  page,
  request,
}) => {
  const receiver = await startHttpMockServer(() => ({
    headers: { 'content-type': 'text/html' },
    rawBody: '<p>Sign-in complete. Return to Founder Hub.</p>',
  }))
  let organizationId: string | undefined
  let connectorClientId: string | undefined
  let connectorToken: string | undefined
  let liveSocket: WebSocket | undefined
  try {
    await createWorkspace(identity, page)
    organizationId = await getActiveOrganizationId(page)
    await db.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [identity.email])
    const signedOut = await page.request.post(getE2EUrl('/api/auth/sign-out'), {
      headers: { origin: new URL(getE2EUrl('/')).origin },
      data: {},
    })
    expect(signedOut.status()).toBe(200)
    const verifier = randomBytes(32).toString('base64url')
    const state = randomUUID()
    const redirectUri = `${receiver.url}/auth/callback`
    const query = new URLSearchParams({
      client_id: 'shots-founder-hub',
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access founder-hub',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })
    await app.open(`/api/auth/oauth2/authorize?${query}`)
    await page.getByLabel('Email').fill(identity.email)
    await page.getByLabel('Password', { exact: true }).fill(identity.password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByText('Sign-in complete. Return to Founder Hub.')).toBeVisible()
    const callback = new URL(page.url())
    expect(callback.origin + callback.pathname).toBe(redirectUri)
    expect(callback.searchParams.get('state')).toBe(state)
    expect(callback.searchParams.get('iss')).toBe(getE2EUrl('/api/auth'))
    const code = callback.searchParams.get('code')
    expect(code).toBeTruthy()
    const form = {
      client_id: 'shots-founder-hub',
      resource: getE2EUrl('/api/founder-hub'),
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }
    const exchange = await request.post(getE2EUrl('/api/auth/oauth2/token'), { form })
    expect(exchange.status()).toBe(200)
    const tokens = z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await exchange.json())
    const replay = await request.post(getE2EUrl('/api/auth/oauth2/token'), { form })
    expect(replay.status()).toBe(401)
    const refreshForm = {
      client_id: form.client_id,
      resource: form.resource,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }
    const concurrentRefresh = await Promise.all(
      Array.from({ length: 3 }, () =>
        request.post(getE2EUrl('/api/auth/oauth2/token'), { form: refreshForm })
      )
    )
    const rotated = []
    for (const response of concurrentRefresh) {
      expect(response.status()).toBe(200)
      rotated.push(
        z
          .object({ access_token: z.string(), refresh_token: z.string() })
          .parse(await response.json())
      )
    }
    expect(rotated[1]).toEqual(rotated[0])
    expect(rotated[2]).toEqual(rotated[0])
    const lostResponseRetry = await request.post(getE2EUrl('/api/auth/oauth2/token'), {
      form: refreshForm,
    })
    expect(lostResponseRetry.status()).toBe(200)
    expect(await lostResponseRetry.json()).toMatchObject(rotated[0])
    const malformedReplay = await request.post(getE2EUrl('/api/auth/oauth2/token'), {
      headers: {
        authorization: `Basic ${Buffer.from('shots-founder-hub:unused').toString('base64')}`,
      },
      form: { ...refreshForm, client_id: 'x'.repeat(161) },
    })
    expect(malformedReplay.status()).toBe(400)
    Object.assign(tokens, rotated[0])
    const publicHeaders = { authorization: `Bearer ${tokens.access_token}` }
    expect(
      (
        await request.get(getE2EUrl('/api/founder-hub/session'), { headers: publicHeaders })
      ).status()
    ).toBe(403)
    const headers = {
      ...publicHeaders,
      'x-shots-founder-hub-service': z.string().min(32).parse(process.env.SHOTS_AUTH_SERVICE_TOKEN),
    }
    const access = await request.get(getE2EUrl('/api/founder-hub/session'), { headers })
    expect(access.status()).toBe(200)
    const current = founderHubAccessSchema.parse(await access.json())
    expect(current.user.email).toBe(identity.email)
    expect(
      await db.row('SELECT "accountUserId" FROM platform_founder_hub_user WHERE "userId"=$1', [
        current.user.id,
      ])
    ).toMatchObject({ accountUserId: current.accountUserId })
    const keyBinding = { userId: current.user.id, sessionId: current.sessionId }
    expect(
      (await request.post(getE2EUrl('/api/founder-hub/key-session'), { data: keyBinding })).status()
    ).toBe(403)
    const serviceHeaders = { 'x-shots-founder-hub-service': headers['x-shots-founder-hub-service'] }
    expect(
      (
        await request.post(getE2EUrl('/api/founder-hub/key-session'), {
          headers: serviceHeaders,
          data: keyBinding,
        })
      ).status()
    ).toBe(200)
    const syncApi = process.env.FOUNDER_HUB_SYNC_API_URL
    let connectorKey: string | undefined
    if (syncApi) {
      const encryptionKeyId = randomBytes(16).toString('base64url')
      const deviceFingerprint = randomUUID()
      const replica = await request.post(`${syncApi}/sync/replica/credentials`, {
        headers: {
          ...publicHeaders,
          'x-anarlog-e2ee-key-id': encryptionKeyId,
          'x-device-fingerprint': deviceFingerprint,
        },
      })
      expect(replica.status()).toBe(200)
      expect(await replica.json()).toMatchObject({
        transport: 'replica',
        encryptionKeyId,
        accountUserId: current.accountUserId,
        personalWorkspaceId: current.accountUserId,
      })
      expect(
        (
          await request.post(`${syncApi}/sync/token`, {
            headers: {
              ...publicHeaders,
              'x-anarlog-e2ee-key-id': encryptionKeyId,
              'x-device-fingerprint': deviceFingerprint,
              'x-anarlog-cloudsync-transports': 'replica',
            },
          })
        ).status()
      ).toBe(200)
      const share = await request.post(
        `${process.env.FOUNDER_HUB_API_URL}/cloud/rest/v1/rpc/create_session_share`,
        {
          headers: publicHeaders,
          data: { p_workspace_id: current.accountUserId, p_session_id: randomUUID() },
        }
      )
      expect(share.status()).toBe(200)
      const [{ share_id: shareId }] = z
        .array(z.object({ share_id: z.uuid() }))
        .length(1)
        .parse(await share.json())
      const published = await request.put(`${syncApi}/sync/shares/${shareId}/snapshot`, {
        headers: publicHeaders,
        data: {
          baseRevision: 0,
          mutationId: randomUUID(),
          title: 'Live integration',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live content' }] }],
          },
          attachmentIds: [],
        },
      })
      expect(published.status()).toBe(200)
      const ticketResponse = await request.post(`${syncApi}/sync/shares/${shareId}/live/ticket`, {
        headers: publicHeaders,
      })
      expect(ticketResponse.status()).toBe(200)
      const ticket = z
        .object({ ticket: z.string(), requiresAuth: z.literal(true) })
        .parse(await ticketResponse.json())
      const socket = new WebSocket(
        `${syncApi.replace(/^http/, 'ws')}/sync/shares/${shareId}/live?ticket=${encodeURIComponent(ticket.ticket)}`
      )
      liveSocket = socket
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          'open',
          () => socket.send(JSON.stringify({ accessToken: tokens.access_token })),
          { once: true }
        )
        socket.addEventListener('error', () => reject(new Error('Live connection failed')), {
          once: true,
        })
        socket.addEventListener(
          'close',
          () => reject(new Error('Live connection closed before ready')),
          { once: true }
        )
        socket.addEventListener('message', ({ data }) => {
          if (typeof data === 'string' && JSON.parse(data).type === 'ready') resolve()
        })
      })
      socket.send(new Uint8Array([0, 0, 1, 0]))
      const witnessUrl = `${syncApi}/sync/e2ee/witness/${current.accountUserId}`
      const event = {
        recordId: randomBytes(32).toString('base64url'),
        payload: JSON.stringify({
          version: 1,
          key_id: encryptionKeyId,
          nonce: randomBytes(24).toString('base64url'),
          ciphertext: randomBytes(64).toString('base64url'),
        }),
      }
      const witness = await request.post(witnessUrl, {
        headers: publicHeaders,
        data: {
          initialize: true,
          events: [
            {
              ...event,
              payloadHash: createHash('sha256').update(event.payload).digest('base64url'),
            },
          ],
        },
      })
      expect(witness.status()).toBe(200)
      const witnessHead = z
        .object({ headSequence: z.number().positive() })
        .parse(await witness.json()).headSequence
      const witnessRead = await request.get(witnessUrl, { headers: publicHeaders })
      expect(witnessRead.status()).toBe(200)
      expect(await witnessRead.json()).toMatchObject({
        initialized: true,
        headSequence: witnessHead,
        events: [event],
      })
      expect(
        (
          await request.get(`${syncApi}/sync/e2ee/witness/${randomUUID()}`, {
            headers: publicHeaders,
          })
        ).status()
      ).toBe(403)
      const settingsUrl = `${syncApi}/v1/cloud-api/settings`
      const keysUrl = `${syncApi}/v1/cloud-api/keys`
      expect(
        (
          await request.put(settingsUrl, { headers: publicHeaders, data: { enabled: true } })
        ).status()
      ).toBe(200)
      const issued = await request.post(keysUrl, {
        headers: publicHeaders,
        data: { name: 'Integration' },
      })
      expect(issued.status()).toBe(201)
      const key = z.object({ id: z.uuid(), key: z.string() }).parse(await issued.json())
      const keyHeaders = { authorization: `Bearer ${key.key}` }
      const meetingId = randomUUID()
      const snapshot = {
        id: meetingId,
        title: 'Founder Hub integration',
        kind: 'meeting',
        status: 'done',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        started_at: '',
        ended_at: '',
        timezone: 'UTC',
        language: 'en',
        series_id: '',
        note: null,
        summaries: [],
        participants: [],
        action_items: [],
        transcripts: [],
      }
      const snapshotUrl = `${syncApi}/v1/sync-snapshots/${meetingId}`
      expect(
        (await request.put(snapshotUrl, { headers: publicHeaders, data: snapshot })).status()
      ).toBe(400)
      expect(
        (
          await request.put(snapshotUrl, {
            headers: publicHeaders,
            data: { ...snapshot, source_workspace_id: randomUUID() },
          })
        ).status()
      ).toBe(403)
      expect(
        (
          await request.put(snapshotUrl, {
            headers: publicHeaders,
            data: { ...snapshot, source_workspace_id: current.accountUserId },
          })
        ).status()
      ).toBe(200)
      const exported = await request.get(`${syncApi}/v1/meetings/${meetingId}/export`, {
        headers: keyHeaders,
      })
      expect(exported.status()).toBe(200)
      expect(await exported.json()).not.toHaveProperty('source_workspace_id')
      expect((await request.get(`${syncApi}/v1/meetings`, { headers: keyHeaders })).status()).toBe(
        200
      )
      expect((await request.get(settingsUrl, { headers: keyHeaders })).status()).toBe(401)
      expect(
        (
          await request.put(settingsUrl, { headers: publicHeaders, data: { enabled: false } })
        ).status()
      ).toBe(200)
      expect((await request.get(`${syncApi}/v1/meetings`, { headers: keyHeaders })).status()).toBe(
        403
      )
      expect(
        (
          await request.put(settingsUrl, { headers: publicHeaders, data: { enabled: true } })
        ).status()
      ).toBe(200)
      await grantWorkspacePlan(organizationId, 'free')
      expect((await request.get(`${syncApi}/v1/meetings`, { headers: keyHeaders })).status()).toBe(
        403
      )
      await grantWorkspacePlan(organizationId, 'pro')
      expect((await request.get(`${syncApi}/v1/meetings`, { headers: keyHeaders })).status()).toBe(
        200
      )
      expect(
        (await request.delete(`${keysUrl}/${key.id}`, { headers: publicHeaders })).status()
      ).toBe(204)
      expect((await request.get(`${syncApi}/v1/meetings`, { headers: keyHeaders })).status()).toBe(
        401
      )
      const second = await request.post(keysUrl, {
        headers: publicHeaders,
        data: { name: 'Session revocation' },
      })
      expect(second.status()).toBe(201)
      connectorKey = z.object({ key: z.string() }).parse(await second.json()).key
      expect(
        (
          await request.put(snapshotUrl, {
            headers: publicHeaders,
            data: { ...snapshot, source_workspace_id: current.accountUserId },
          })
        ).status()
      ).toBe(200)

      const discovery = await request.get(`${syncApi}/.well-known/oauth-protected-resource/mcp`)
      expect(await discovery.json()).toMatchObject({
        resource: `${syncApi}/mcp`,
        authorization_servers: [getE2EUrl('/api/auth')],
        scopes_supported: ['founder-hub:meetings:read', 'offline_access'],
      })
      const issuer = await request.get(
        getE2EUrl('/.well-known/oauth-authorization-server/api/auth')
      )
      expect(await issuer.json()).toMatchObject({
        issuer: getE2EUrl('/api/auth'),
        registration_endpoint: getE2EUrl('/api/auth/oauth2/register'),
      })
      const registration = {
        client_name: 'Integration connector',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
      }
      const forbidden = await request.post(getE2EUrl('/api/auth/oauth2/register'), {
        data: { ...registration, scope: 'founder-hub' },
      })
      expect(forbidden.status()).toBe(400)
      const registered = await request.post(getE2EUrl('/api/auth/oauth2/register'), {
        data: registration,
      })
      expect(registered.status()).toBe(200)
      connectorClientId = z
        .object({ client_id: z.string() })
        .parse(await registered.json()).client_id
      const connectorQuery = new URLSearchParams(query)
      connectorQuery.set('client_id', connectorClientId)
      connectorQuery.set('scope', 'openid profile email offline_access founder-hub:meetings:read')
      connectorQuery.set('resource', `${syncApi}/mcp`)
      await app.open(`/api/auth/oauth2/authorize?${connectorQuery}`)
      await expect(page.getByText(/Allow Integration connector to read/)).toBeVisible()
      const consentUrl = new URL(page.url())
      const tampered = new URL(consentUrl)
      tampered.searchParams.set('client_id', 'shots-founder-hub')
      await page.goto(tampered.toString())
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
      await page.goto(consentUrl.toString())
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.getByText('Sign-in complete. Return to Founder Hub.')).toBeVisible()
      const connectorExchange = await request.post(getE2EUrl('/api/auth/oauth2/token'), {
        form: {
          ...form,
          client_id: connectorClientId,
          resource: `${syncApi}/mcp`,
          code: new URL(page.url()).searchParams.get('code')!,
        },
      })
      expect(connectorExchange.status()).toBe(200)
      const connectorTokens = z
        .object({ access_token: z.string(), refresh_token: z.string() })
        .parse(await connectorExchange.json())
      connectorToken = connectorTokens.access_token
      const connectorHeaders = { authorization: `Bearer ${connectorToken}` }
      expect((await request.get(settingsUrl, { headers: connectorHeaders })).status()).toBe(401)
      expect(
        (
          await request.get(getE2EUrl('/api/founder-hub/session'), {
            headers: { ...serviceHeaders, ...connectorHeaders },
          })
        ).status()
      ).toBe(401)
      expect(
        (await request.get(getE2EUrl('/api/founder-hub/connector-session'), { headers })).status()
      ).toBe(401)
      const toolHeaders = {
        ...connectorHeaders,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-03-26',
      }
      const listed = await request.post(`${syncApi}/mcp`, {
        headers: toolHeaders,
        data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      })
      expect(listed.status()).toBe(200)
      const tools = z
        .object({
          result: z.object({
            tools: z.array(
              z.object({
                _meta: z.object({
                  securitySchemes: z.array(z.object({ scopes: z.array(z.string()) })),
                }),
              })
            ),
          }),
        })
        .parse(await listed.json())
      expect(tools.result.tools).toHaveLength(5)
      for (const tool of tools.result.tools)
        expect(tool._meta.securitySchemes[0].scopes).toContain('founder-hub:meetings:read')
      const meetings = await request.post(`${syncApi}/mcp`, {
        headers: toolHeaders,
        data: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_meetings', arguments: {} },
        },
      })
      expect(meetings.status()).toBe(200)
      expect(await meetings.text()).toContain(meetingId)
      await db.query('UPDATE "oauthConsent" SET scopes=$2 WHERE "clientId"=$1', [
        connectorClientId,
        '["offline_access"]',
      ])
      expect(
        (await request.get(`${syncApi}/v1/meetings`, { headers: connectorHeaders })).status()
      ).toBe(401)
      await db.query('UPDATE "oauthConsent" SET scopes=$2 WHERE "clientId"=$1', [
        connectorClientId,
        '["founder-hub:meetings:read","offline_access"]',
      ])
      expect(
        (await request.get(`${syncApi}/v1/meetings`, { headers: connectorHeaders })).status()
      ).toBe(200)
      const refreshedConnector = await request.post(getE2EUrl('/api/auth/oauth2/token'), {
        form: {
          client_id: connectorClientId,
          grant_type: 'refresh_token',
          resource: `${syncApi}/mcp`,
          refresh_token: connectorTokens.refresh_token,
        },
      })
      expect(refreshedConnector.status()).toBe(200)
      connectorToken = z
        .object({ access_token: z.string() })
        .parse(await refreshedConnector.json()).access_token
    }
    const hubOrigin = process.env.FOUNDER_HUB_WEB_ORIGIN
    if (hubOrigin) {
      const pendingCookie = page.waitForResponse(
        async (response) =>
          response.url().startsWith(hubOrigin) &&
          response.request().method() === 'POST' &&
          (await response.allHeaders())['set-cookie']?.includes('shots-hub-oauth') === true
      )
      await page.goto(`${hubOrigin}/auth?flow=web&redirect=%2Fapp%2Faccount`)
      const startResponse = await pendingCookie
      expect((await startResponse.allHeaders())['set-cookie']).toMatch(/HttpOnly/i)
      await expect(
        page.getByText('Your account, teams, and plan are managed by Shots.')
      ).toBeVisible()
      expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/app/account')
      expect(page.url()).not.toMatch(/access_token|refresh_token/)
      await page.reload()
      await expect(
        page.getByText('Your account, teams, and plan are managed by Shots.')
      ).toBeVisible()
      await expect(page.getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute(
        'href',
        new RegExp(`user=${current.user.id}&section=members`)
      )
      expect(
        (
          await page.request.post(startResponse.url(), {
            headers: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
            data: {},
          })
        ).status()
      ).toBe(403)
    }
    const management = new URLSearchParams({ user: current.user.id, section: 'members' })
    await app.open(
      `/founder-hub/manage?${new URLSearchParams({ user: 'another-account', section: 'members' })}`
    )
    await expect(page.getByRole('heading', { name: 'Use your Founder Hub account' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Switch account' })).toHaveAttribute(
      'href',
      /reauthenticate=1/
    )
    const settings = await page.request.get(getE2EUrl(`/founder-hub/manage?${management}`), {
      maxRedirects: 0,
    })
    expect(settings.status()).toBe(307)
    expect(settings.headers().location).toBe('/settings/members')
    expect(
      (
        await page.request.get(
          getE2EUrl(`/founder-hub/manage?user=${current.user.id}&section=https://attacker.example`)
        )
      ).status()
    ).toBe(404)
    if (liveSocket) expect(liveSocket.readyState).toBe(WebSocket.OPEN)
    expect((await request.post(getE2EUrl('/api/founder-hub/logout'), { headers })).status()).toBe(
      200
    )
    if (liveSocket) {
      liveSocket.send(new Uint8Array([0, 0, 1, 0]))
      await expect.poll(() => liveSocket?.readyState).toBe(WebSocket.CLOSED)
    }
    expect((await request.get(getE2EUrl('/api/founder-hub/session'), { headers })).status()).toBe(
      401
    )
    expect(
      (
        await request.post(getE2EUrl('/api/auth/oauth2/token'), {
          form: {
            client_id: form.client_id,
            resource: form.resource,
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
          },
        })
      ).status()
    ).toBe(400)
    expect(await db.row('SELECT id FROM session WHERE id=$1', [current.sessionId])).toBeNull()
    expect(
      (
        await request.post(getE2EUrl('/api/founder-hub/key-session'), {
          headers: serviceHeaders,
          data: keyBinding,
        })
      ).status()
    ).toBe(401)
    if (syncApi && connectorKey) {
      expect(
        (
          await request.get(`${syncApi}/v1/meetings`, {
            headers: { authorization: `Bearer ${connectorKey}` },
          })
        ).status()
      ).toBe(401)
    }
    if (syncApi && connectorToken) {
      expect(
        (
          await request.get(`${syncApi}/v1/meetings`, {
            headers: { authorization: `Bearer ${connectorToken}` },
          })
        ).status()
      ).toBe(401)
    }
    if (syncApi) {
      expect(
        (
          await request.get(`${syncApi}/sync/e2ee/witness/${current.accountUserId}`, {
            headers: publicHeaders,
          })
        ).status()
      ).toBe(401)
    }
    const signedOutSettings = await page.request.get(
      getE2EUrl(`/founder-hub/manage?${management}`),
      { maxRedirects: 0 }
    )
    expect(signedOutSettings.status()).toBe(307)
    expect(signedOutSettings.headers().location).toContain('/sign-in?callbackURL=')
    if (hubOrigin) {
      await page.goto(`${hubOrigin}/app/account/`)
      await expect(page.getByLabel('Email')).toBeVisible()
      expect(new URL(page.url()).origin).toBe(new URL(getE2EUrl('/')).origin)
    }
    const cli = process.env.FOUNDER_HUB_CLI_BIN
    if (cli) {
      expect(
        (
          await page.request.post(getE2EUrl('/api/auth/sign-in/email'), {
            headers: { origin: new URL(getE2EUrl('/')).origin },
            data: { email: identity.email, password: identity.password },
          })
        ).status()
      ).toBe(200)
      const browserSession = z
        .object({ session: z.object({ id: z.string() }) })
        .parse(await (await page.request.get(getE2EUrl('/api/auth/get-session'))).json()).session.id
      const directory = await mkdtemp(join(tmpdir(), 'founder-hub-cli-'))
      const authPath = join(directory, 'auth.json')
      const env = {
        ...process.env,
        ANARLOG_SHOTS_URL: new URL(getE2EUrl('/')).origin,
        ANARLOG_API_URL: z.string().url().parse(process.env.FOUNDER_HUB_API_URL),
        ANARLOG_AUTH_PATH: authPath,
      }
      const login = spawn(cli, ['--json', 'auth', 'login'], { env })
      let stderr = ''
      let stdout = ''
      login.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      login.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve, reject) => {
        login.once('error', reject)
        login.once('close', resolve)
      })
      try {
        await expect.poll(() => stderr.match(/https?:\/\/[^\s]+/)?.[0]).toBeTruthy()
        await page.goto(stderr.match(/https?:\/\/[^\s]+/)![0])
        await page.getByLabel('Email').fill(identity.email)
        await page.getByLabel('Password', { exact: true }).fill(identity.password)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(
          page.getByText('Sign-in received. Return to the terminal to finish.')
        ).toBeVisible()
        expect(await exited).toBe(0)
        expect(JSON.parse(stdout).data).toMatchObject({
          signed_in: true,
          user_id: current.accountUserId,
          email: identity.email,
        })
        const data = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await readFile(authPath, 'utf8')))
        const key = Object.keys(data).find((key) => key.endsWith('-auth-token'))!
        const session = z
          .object({ access_token: z.string(), refresh_token: z.string(), expires_at: z.number() })
          .passthrough()
          .parse(JSON.parse(data[key]!))
        session.expires_at = 1
        data[key] = JSON.stringify(session)
        await writeFile(authPath, JSON.stringify(data))
        const status = await promisify(execFile)(cli, ['--json', 'auth', 'status'], { env })
        expect(JSON.parse(status.stdout).data).toMatchObject({
          signed_in: true,
          expired: false,
          user_id: current.accountUserId,
        })
        const refreshedData = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await readFile(authPath, 'utf8')))
        const refreshed = z
          .object({ access_token: z.string(), refresh_token: z.string() })
          .parse(JSON.parse(refreshedData[key]!))
        expect(refreshed.refresh_token !== session.refresh_token).toBe(true)
        const cliHeaders = { ...headers, authorization: `Bearer ${refreshed.access_token}` }
        const cliAccess = await request.get(getE2EUrl('/api/founder-hub/session'), {
          headers: cliHeaders,
        })
        expect(cliAccess.status()).toBe(200)
        const cliSession = founderHubAccessSchema.parse(await cliAccess.json())
        expect(cliSession.sessionId).not.toBe(browserSession)
        const logout = await promisify(execFile)(cli, ['--json', 'auth', 'logout'], { env })
        expect(JSON.parse(logout.stdout).data.signed_in).toBe(false)
        expect(
          (
            await request.get(getE2EUrl('/api/founder-hub/session'), { headers: cliHeaders })
          ).status()
        ).toBe(401)
        expect(
          await db.row('SELECT id FROM session WHERE id=$1', [cliSession.sessionId])
        ).toBeNull()
        expect(await db.row('SELECT id FROM session WHERE id=$1', [browserSession])).toMatchObject({
          id: browserSession,
        })
      } finally {
        liveSocket?.close()
        if (login.exitCode === null) login.kill()
        await exited.catch(() => {})
        await rm(directory, { recursive: true, force: true })
      }
    }
    const newPassword = 'updated-e2e-only-password'
    const passwordLogin = await page.request.post(getE2EUrl('/api/auth/sign-in/email'), {
      headers: { origin: new URL(getE2EUrl('/')).origin },
      data: { email: identity.email, password: identity.password },
    })
    expect(passwordLogin.status()).toBe(200)
    const otherLogin = await request.post(getE2EUrl('/api/auth/sign-in/email'), {
      headers: { origin: new URL(getE2EUrl('/')).origin },
      data: { email: identity.email, password: identity.password },
    })
    expect(otherLogin.status()).toBe(200)
    const otherToken = z.object({ token: z.string() }).parse(await otherLogin.json()).token
    await app.open('/settings/account')
    await page.getByLabel('Current password', { exact: true }).fill('incorrect-password')
    await page.getByLabel('New password', { exact: true }).fill(newPassword)
    await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword)
    await page.getByRole('button', { name: 'Change password', exact: true }).click()
    await expect(page.getByRole('alert').filter({ hasText: /password/i })).toBeVisible()
    await page.getByLabel('Current password', { exact: true }).fill(identity.password)
    await page.getByRole('button', { name: 'Change password', exact: true }).click()
    await expect(
      page.getByText('Password changed. Your other devices are signed out.')
    ).toBeVisible()
    expect(await db.row('SELECT id FROM session WHERE token=$1', [otherToken])).toBeNull()
    expect(
      (
        await request.post(getE2EUrl('/api/auth/sign-in/email'), {
          data: { email: identity.email, password: identity.password },
          headers: { origin: new URL(getE2EUrl('/')).origin },
        })
      ).status()
    ).toBe(401)
    expect(
      (
        await request.post(getE2EUrl('/api/auth/sign-in/email'), {
          data: { email: identity.email, password: newPassword },
          headers: { origin: new URL(getE2EUrl('/')).origin },
        })
      ).status()
    ).toBe(200)
  } finally {
    if (connectorClientId)
      await db.query('DELETE FROM "oauthClient" WHERE "clientId"=$1', [connectorClientId])
    await receiver.close()
    await db.query('DELETE FROM session WHERE "userId" IN (SELECT id FROM "user" WHERE email=$1)', [
      identity.email,
    ])
    if (!organizationId) await db.query('DELETE FROM "user" WHERE email=$1', [identity.email])
  }
})

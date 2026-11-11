import { randomUUID } from 'node:crypto'
import {
  bindTestGoOrganization,
  connectionSchema,
  contrastOf,
  createApprovedVariant,
  createScheduledPost,
  createWorkspace,
  db,
  e2eSecretReference,
  enableTwoFactor,
  expect,
  getE2EUrl,
  scheduledPostSchema,
  socialMockPort,
  startHttpMockServer,
  test,
  trpcMutation,
  unbindTestGoOrganization,
  unroutedSocialRequests,
  xVerification,
} from './framework'

/** A provider identity response for an X destination; attaching one verifies it. */
function verifiedXIdentity(id: string) {
  return {
    body: {
      id,
      provider: 'x',
      nativeId: '123456789',
      name: 'Fixture X profile',
      handle: 'fixture_x',
      active: true,
      verifiedAt: new Date().toISOString(),
      verification: xVerification,
    },
  }
}

async function expectOAuthConnection(
  organizationId: string | null,
  integrationId: string,
  state: string,
  platform: string
): Promise<void> {
  expect(
    await db.row(
      `SELECT platform, "secretReference" FROM channel_connection
         WHERE "externalAccountId" = $1 AND "organizationId" = $2 LIMIT 1`,
      [integrationId, organizationId]
    )
  ).toEqual({ platform, secretReference: e2eSecretReference })
  // The start is kept as a completed, one-use receipt for the confirmation page.
  expect(
    await db.row('SELECT "exchangeStatus" FROM social_oauth_start WHERE state = $1', [state])
  ).toEqual({ exchangeStatus: 'COMPLETED' })
}

async function deleteOAuthStart(state: string): Promise<void> {
  await db.query('DELETE FROM social_oauth_start WHERE state = $1', [state])
}

// Dispatch, retries, revocation, and recovery run in the Go publishing worker
// (server/internal/temporalpublishing) and are covered by its tests. These
// flows cover what the web still owns: verified destinations, idempotent
// scheduling, cancellation, tenant isolation, and the OAuth callbacks.
test(
  'an approved variant schedules once to a verified Go destination and can be cancelled',
  { tag: '@smoke' },
  async ({ identity, page }) => {
    let organizationId: string | null = null
    const provider = await startHttpMockServer((request) => {
      if (request.url === '/api/public/v1/me') {
        return { body: { organization: { id: `go-${organizationId}` } } }
      }
      if (request.url === '/api/public/v1/integrations/social-x-integration/identity') {
        return verifiedXIdentity('social-x-integration')
      }
      return { body: { error: 'Not found.' }, status: 404 }
    }, socialMockPort)

    try {
      await createWorkspace(identity, page)
      await enableTwoFactor(page, identity.password)
      const variantId = await createApprovedVariant(page)
      const unbound = await trpcMutation(page, 'channelConnection.create', {
        externalAccountId: 'social-x-integration',
        platform: 'x',
        secretReference: e2eSecretReference,
      })
      expect(unbound.status).toBe(409)
      expect(provider.calls).toHaveLength(0)

      organizationId = await bindTestGoOrganization(page)
      const wrongCredential = await trpcMutation(page, 'channelConnection.create', {
        externalAccountId: 'social-x-integration',
        platform: 'x',
        secretReference: 'SOCIAL_API_KEY',
      })
      expect(wrongCredential.status).toBe(409)
      expect(provider.calls).toHaveLength(0)
      // The router drops a call with another credential, so prove there was none.
      expect(
        (await unroutedSocialRequests()).filter((call) => call.url.includes('social-x-integration'))
      ).toEqual([])
      const foreignDestination = await trpcMutation(page, 'channelConnection.create', {
        externalAccountId: 'another-organizations-destination',
        platform: 'x',
        secretReference: e2eSecretReference,
      })
      expect(foreignDestination.status).toBe(404)
      expect(provider.calls.map((call) => call.url)).toEqual([
        '/api/public/v1/me',
        '/api/public/v1/integrations/another-organizations-destination/identity',
      ])
      const connectionResponse = await trpcMutation(page, 'channelConnection.create', {
        externalAccountId: 'social-x-integration',
        platform: 'x',
        providerSettings: { who_can_reply_post: 'everyone' },
        secretReference: e2eSecretReference,
      })
      expect(connectionResponse.status).toBe(200)
      const connectionId = connectionSchema.parse(connectionResponse.body).connection.id

      const first = await createScheduledPost(page, connectionId, 'social-launch', variantId)
      expect(first.response.status).toBe(200)
      expect(scheduledPostSchema.parse(first.response.body).created).toBe(true)
      const duplicate = await createScheduledPost(page, connectionId, 'social-launch', variantId)
      expect(duplicate.response.status).toBe(200)
      expect(scheduledPostSchema.parse(duplicate.response.body).created).toBe(false)
      expect(duplicate.scheduledPost.id).toBe(first.scheduledPost.id)

      const cancelResponse = await trpcMutation(page, 'scheduledPost.cancel', {
        scheduledPostId: first.scheduledPost.id,
      })
      expect(cancelResponse).toMatchObject({
        body: { scheduledPost: { status: 'CANCELLED' } },
        status: 200,
      })
    } finally {
      await provider.close()
      await unbindTestGoOrganization(organizationId)
    }
  }
)

test(
  'another workspace cannot attach or control a bound Go destination',
  { tag: '@smoke' },
  async ({ browser, identity, page }) => {
    let organizationId: string | null = null
    const backend = await startHttpMockServer(
      (request) =>
        request.url === '/api/public/v1/me'
          ? { body: { organization: { id: `go-${organizationId}` } } }
          : request.url === '/api/public/v1/integrations/tenant-a-destination/identity'
            ? verifiedXIdentity('tenant-a-destination')
            : { body: { error: 'Unexpected request.' }, status: 500 },
      socialMockPort
    )
    const secondContext = await browser.newContext()
    try {
      await createWorkspace(identity, page)
      await enableTwoFactor(page, identity.password)
      organizationId = await bindTestGoOrganization(page)
      const variantId = await createApprovedVariant(page)
      const connection = connectionSchema.parse(
        (
          await trpcMutation(page, 'channelConnection.create', {
            externalAccountId: 'tenant-a-destination',
            platform: 'x',
            secretReference: e2eSecretReference,
          })
        ).body
      ).connection
      const post = await createScheduledPost(page, connection.id, 'tenant-a-post', variantId)
      const providerCallCount = backend.calls.length

      const secondPage = await secondContext.newPage()
      const secondIdentity = {
        ...identity,
        email: `foreign-${identity.email}`,
        workspaceName: `Foreign ${identity.workspaceName}`,
      }
      await createWorkspace(secondIdentity, secondPage)
      await enableTwoFactor(secondPage, secondIdentity.password)
      expect(
        (
          await trpcMutation(secondPage, 'channelConnection.create', {
            externalAccountId: 'tenant-a-destination',
            platform: 'x',
            secretReference: e2eSecretReference,
          })
        ).status
      ).toBe(409)
      const foreignSchedule = await trpcMutation(secondPage, 'scheduledPost.create', {
        caption: 'A foreign post',
        channelConnectionId: connection.id,
        idempotencyKey: 'foreign-schedule',
        scheduledFor: new Date(Date.now() + 60_000).toISOString(),
        variantId,
      })
      expect(foreignSchedule.status, JSON.stringify(foreignSchedule.body)).toBe(404)
      expect(
        (
          await trpcMutation(secondPage, 'scheduledPost.cancel', {
            scheduledPostId: post.scheduledPost.id,
          })
        ).status
      ).toBe(404)
      expect(backend.calls).toHaveLength(providerCallCount)
    } finally {
      await secondContext.close()
      await unbindTestGoOrganization(organizationId)
      await backend.close()
    }
  }
)

test('X OAuth start binds its one-use callback to the active workspace', async ({
  app,
  identity,
  page,
}) => {
  let organizationId: string | null = null
  const state = `oauth-state-for-x-${randomUUID()}`
  const integrationId = 'go-x-test-integration'
  const backend = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/me') {
      return { body: { organization: { id: `go-${organizationId}` } } }
    }
    if (request.url === '/api/public/v1/social/x') {
      return {
        body: { url: `https://api.x.com/oauth/authenticate?oauth_token=${state}` },
      }
    }
    if (request.url === '/integrations/social-connect/x') {
      return { body: { id: integrationId, pages: [] } }
    }
    if (request.url === `/api/public/v1/integrations/${integrationId}/identity`) {
      return verifiedXIdentity(integrationId)
    }
    if (request.url === '/api/public/v1/integrations') {
      return { body: [{ id: integrationId, identifier: 'x', disabled: false }] }
    }
    return { body: { error: 'Not found.' }, status: 404 }
  }, socialMockPort)

  try {
    await createWorkspace(identity, page)
    await enableTwoFactor(page, identity.password)
    organizationId = await bindTestGoOrganization(page)

    const start = await page.context().request.get(getE2EUrl('/integrations/social/x/start'), {
      maxRedirects: 0,
    })
    expect(start.status(), `${await start.text()} ${backend.calls.map((call) => call.url)}`).toBe(
      303
    )
    expect(start.headers().location).toBe(
      `https://api.x.com/oauth/authenticate?oauth_token=${state}`
    )

    await app.open(`/integrations/social/x?oauth_token=${state}&oauth_verifier=test-verifier`)
    await expect(page).toHaveURL(/\/settings\/channels\?connected=x$/)
    await expect(page.getByText('X is connected.')).toBeVisible()
    // One row per platform: the new account shows as a chip, with its status in words, and
    // the row's button, now Add another, keeps its width and reads on the light card.
    const xRow = page.locator('#channels-x')
    await expect(xRow.getByTestId('channel-account')).toHaveCount(1)
    await expect(xRow.getByTestId('channel-account')).toContainText(
      /Active|Needs reconnect|Disconnected/
    )
    await expect(xRow.getByRole('link', { name: 'Connect X', exact: true })).toHaveCount(0)
    for (const width of [584, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      const connect = xRow.getByRole('link', { name: 'Add another X account', exact: true })
      await expect(connect).toBeVisible()
      expect((await connect.boundingBox())?.width ?? 0).toBeGreaterThan(120)
      expect(await contrastOf(connect)).toBeGreaterThanOrEqual(4.5)
    }

    await expectOAuthConnection(organizationId, integrationId, state, 'x')

    // The channels page may still be reading integrations in the background;
    // what a replay must never do is complete the connection again.
    const connects = () =>
      backend.calls.filter((call) => call.url.startsWith('/integrations/social-connect/')).length
    const connectsBeforeReplay = connects()
    const replay = await page
      .context()
      .request.get(
        getE2EUrl(`/integrations/social/x?oauth_token=${state}&oauth_verifier=test-verifier`)
      )
    // A replay is answered from the stored receipt; it never reaches the provider again.
    expect(replay.status()).toBe(200)
    expect(connects()).toBe(connectsBeforeReplay)
  } finally {
    await deleteOAuthStart(state)
    await unbindTestGoOrganization(organizationId)
    await backend.close()
  }
})

test('LinkedIn OAuth callback connects through the SDK and rejects replay', async ({
  identity,
  page,
}) => {
  let organizationId: string | null = null
  const state = `oauth-state-for-linkedin-${randomUUID()}`
  const integrationId = 'go-linkedin-test-integration'
  const backend = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/me') {
      return { body: { organization: { id: `go-${organizationId}` } } }
    }
    if (request.url === '/api/public/v1/social/linkedin') {
      return { body: { url: `https://www.linkedin.com/oauth/v2/authorization?state=${state}` } }
    }
    if (request.url === '/integrations/social-connect/linkedin') {
      return { body: { id: integrationId, pages: [] } }
    }
    if (request.url === '/api/public/v1/integrations') {
      return { body: [{ id: integrationId, identifier: 'linkedin', disabled: false }] }
    }
    return { body: { error: 'Not found.' }, status: 404 }
  }, socialMockPort)
  try {
    await createWorkspace(identity, page)
    await enableTwoFactor(page, identity.password)
    organizationId = await bindTestGoOrganization(page)

    const start = await page
      .context()
      .request.get(getE2EUrl('/integrations/social/linkedin/start'), {
        maxRedirects: 0,
      })
    expect(start.status()).toBe(303)
    expect(start.headers().location).toBe(
      `https://www.linkedin.com/oauth/v2/authorization?state=${state}`
    )

    const callbackURL = getE2EUrl(`/integrations/social/linkedin?code=test-code&state=${state}`)
    const callback = await page.context().request.get(callbackURL, { maxRedirects: 0 })
    expect(callback.status(), await callback.text()).toBe(303)
    // The callback hands off to the receipt page, which redirects to Channels.
    expect(callback.headers().location).toMatch(
      /^\/integrations\/social\/linkedin\/complete\?state=/
    )
    await expectOAuthConnection(organizationId, integrationId, state, 'linkedin')

    const callsBeforeReplay = backend.calls.length
    // A replay is answered from the stored receipt; it never reaches the provider again.
    expect((await page.context().request.get(callbackURL)).status()).toBe(200)
    expect(backend.calls).toHaveLength(callsBeforeReplay)
  } finally {
    await deleteOAuthStart(state)
    await unbindTestGoOrganization(organizationId)
    await backend.close()
  }
})

// @quarantine: Instagram was held out of the production lane with no reason
// recorded; the nightly quarantine run decides whether it can rejoin.
for (const [providerName, authorizationURL] of [
  ['instagram', 'https://www.facebook.com/v24.0/dialog/oauth'],
  ['linkedin-page', 'https://www.linkedin.com/oauth/v2/authorization'],
  ['youtube', 'https://accounts.google.com/o/oauth2/v2/auth'],
] as const) {
  test(
    `${providerName} registers only the selected provider account once`,
    providerName === 'instagram' ? { tag: '@quarantine' } : {},
    async ({ identity, page }) => {
      let organizationId: string | null = null
      const state = `oauth-state-for-${providerName}-${randomUUID()}`
      const integrationId = `go-${providerName}-test-integration`
      const backend = await startHttpMockServer((request) => {
        if (request.url === '/api/public/v1/me') {
          return { body: { organization: { id: `go-${organizationId}` } } }
        }
        if (request.url === `/api/public/v1/social/${providerName}`) {
          return {
            body: { url: `${authorizationURL}?state=${state}` },
          }
        }
        if (request.url === `/integrations/social-connect/${providerName}`) {
          return {
            body: {
              id: integrationId,
              pages: [
                { id: 'instagram-test-account', name: 'Test Page', pageId: 'facebook-test-page' },
              ],
            },
          }
        }
        if (request.url === `/integrations/public/provider/${integrationId}/connect`) {
          return { body: { success: true } }
        }
        if (request.url === '/api/public/v1/integrations') {
          return { body: [{ id: integrationId, identifier: providerName, disabled: false }] }
        }
        return { body: { error: 'Not found.' }, status: 404 }
      }, socialMockPort)
      try {
        await createWorkspace(identity, page)
        organizationId = await bindTestGoOrganization(page)
        await enableTwoFactor(page, identity.password)

        const start = await page
          .context()
          .request.get(getE2EUrl(`/integrations/social/${providerName}/start`), {
            maxRedirects: 0,
          })
        expect(
          start.status(),
          `${await start.text()} ${backend.calls.map((call) => call.url)}`
        ).toBe(303)
        expect(start.headers().location).toBe(`${authorizationURL}?state=${state}`)

        const callbackURL = getE2EUrl(
          `/integrations/social/${providerName}?code=test-code&state=${state}`
        )
        const picker = await page.context().request.get(callbackURL)
        expect(picker.status()).toBe(200)
        const choice = (await picker.text()).match(/name="choice" value="([^"]+)"/)?.[1]
        expect(choice).toBeTruthy()
        const tampered = await page.context().request.post(callbackURL, {
          form: { choice: `${choice}tampered` },
          headers: { origin: new URL(getE2EUrl('/')).origin },
          maxRedirects: 0,
        })
        expect(tampered.status()).toBe(400)
        expect(backend.calls.filter((call) => call.url.endsWith('/connect'))).toHaveLength(0)
        const selection = await page.context().request.post(callbackURL, {
          form: { choice: choice as string },
          headers: { origin: new URL(getE2EUrl('/')).origin },
          maxRedirects: 0,
        })
        expect(selection.status()).toBe(303)
        // The callback hands off to the receipt page, which redirects to Channels.
        expect(selection.headers().location).toMatch(
          new RegExp(`^/integrations/social/${providerName}/complete\\?state=`)
        )

        await expectOAuthConnection(organizationId, integrationId, state, providerName)

        const callsBeforeReplay = backend.calls.length
        const replay = await page.context().request.post(callbackURL, {
          form: { choice: choice as string },
          headers: { origin: new URL(getE2EUrl('/')).origin },
        })
        // A replay is answered from the stored receipt; it never reaches the provider again.
        expect(replay.status()).toBe(200)
        expect(backend.calls).toHaveLength(callsBeforeReplay)
      } finally {
        await deleteOAuthStart(state)
        await unbindTestGoOrganization(organizationId)
        await backend.close()
      }
    }
  )
}

test('Instagram Login registers its destination after a one-use callback', async ({
  identity,
  page,
}) => {
  let organizationId: string | null = null
  const state = `oauth-state-for-instagram-login-${randomUUID()}`
  const integrationId = 'go-instagram-login-test-integration'
  const backend = await startHttpMockServer((request) => {
    if (request.url === '/api/public/v1/me') {
      return { body: { organization: { id: `go-${organizationId}` } } }
    }
    if (request.url === '/api/public/v1/social/instagram-standalone') {
      return { body: { url: `https://www.instagram.com/oauth/authorize?state=${state}` } }
    }
    if (request.url === '/integrations/social-connect/instagram-standalone') {
      return { body: { id: integrationId, pages: [] } }
    }
    if (request.url === '/api/public/v1/integrations') {
      return { body: [{ id: integrationId, identifier: 'instagram-standalone', disabled: false }] }
    }
    return { body: { error: 'Not found.' }, status: 404 }
  }, socialMockPort)
  try {
    await createWorkspace(identity, page)
    organizationId = await bindTestGoOrganization(page)
    await enableTwoFactor(page, identity.password)

    const start = await page
      .context()
      .request.get(getE2EUrl('/integrations/social/instagram-standalone/start'), {
        maxRedirects: 0,
      })
    expect(start.status(), `${await start.text()} ${backend.calls.map((call) => call.url)}`).toBe(
      303
    )
    expect(start.headers().location).toBe(
      `https://www.instagram.com/oauth/authorize?state=${state}`
    )

    const callbackURL = getE2EUrl(
      `/integrations/social/instagram-standalone?code=test-code&state=${state}`
    )
    const callback = await page.context().request.get(callbackURL, { maxRedirects: 0 })
    expect(callback.status()).toBe(303)
    // The callback hands off to the receipt page, which redirects to Channels.
    expect(callback.headers().location).toMatch(
      /^\/integrations\/social\/instagram-standalone\/complete\?state=/
    )
    await expectOAuthConnection(organizationId, integrationId, state, 'instagram-standalone')
    const callsBeforeReplay = backend.calls.length
    // A replay is answered from the stored receipt; it never reaches the provider again.
    expect((await page.context().request.get(callbackURL)).status()).toBe(200)
    expect(backend.calls).toHaveLength(callsBeforeReplay)
  } finally {
    await deleteOAuthStart(state)
    await unbindTestGoOrganization(organizationId)
    await backend.close()
  }
})

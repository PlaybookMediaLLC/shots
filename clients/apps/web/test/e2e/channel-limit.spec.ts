import {
  apiRequest,
  bindTestGoOrganization,
  connectionAvailabilityFixture,
  createWorkspace,
  db,
  enableTwoFactor,
  expect,
  getE2EUrl,
  socialMockPort,
  startHttpMockServer,
  test,
  unbindTestGoOrganization,
  xVerification,
} from './framework'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { socialSetListSchema } from '../../lib/api/contracts/social-sets'

const limitMessage = 'The Pro plan includes 15 social channels. Upgrade the plan to add more.'

test(
  'a workspace at its channel limit refuses another account when it starts and when it commits',
  { tag: '@journey' },
  async ({ app, identity, page }) => {
    let organizationId = ''
    let accounts = 0
    // A local X adapter that authorizes a new account on every exchange.
    const provider = await startHttpMockServer(async (request) => {
      if (request.url === '/api/public/v1/connection-availability')
        return { body: connectionAvailabilityFixture() }
      if (request.url === '/api/public/v1/me')
        return { body: { organization: { id: `go-${organizationId}` } } }
      if (request.url.startsWith('/api/public/v1/social/x'))
        return { body: { url: `https://api.x.com/oauth/authenticate?oauth_token=${randomUUID()}` } }
      if (request.url === '/integrations/social-connect/x') {
        accounts += 1
        return { body: { id: `limit-${organizationId}-${accounts}`, pages: [] } }
      }
      const identityCall = request.url.match(
        /^\/api\/public\/v1\/integrations\/(limit-[^/]+-(\d+))\/identity$/
      )
      if (identityCall?.[1] && identityCall[2]) {
        const nativeId = `9000${identityCall[2]}`
        return {
          body: {
            id: identityCall[1],
            provider: 'x',
            nativeId,
            name: 'Fixture X profile',
            handle: `fixture_${identityCall[2]}`,
            active: true,
            verifiedAt: new Date().toISOString(),
            verification: { ...xVerification, accountKey: `x:${nativeId}` },
          },
        }
      }
      return { status: 404 }
    }, socialMockPort)
    try {
      await createWorkspace(identity, page)
      await enableTwoFactor(page, identity.password)
      organizationId = await bindTestGoOrganization(page)
      const session = await apiRequest(page, '/api/auth/get-session')
      const ownerId = z.object({ user: z.object({ id: z.string() }) }).parse(session.body).user.id
      const hold = async (count: number) => {
        for (let index = 0; index < count; index += 1)
          await db.query(
            `INSERT INTO channel_connection (id,"organizationId",provider,"externalAccountId",platform,"secretReference",status,"createdByUserId","updatedAt")
             VALUES ($1,$2,'social',$3,'linkedin','SOCIAL_API_KEY','ACTIVE',$4,now())`,
            [
              `cl${randomUUID().replaceAll('-', '').slice(0, 24)}`,
              organizationId,
              `held-${randomUUID()}`,
              ownerId,
            ]
          )
      }
      const profiles = async () => {
        const response = await apiRequest(page, '/api/v1/social-sets')
        expect(response.status).toBe(200)
        // Listing gives the held accounts the workspace's default profile; compare IDs.
        return socialSetListSchema.parse(response.body).items.map((set) => set.id)
      }
      // One slot is left when the person starts connecting.
      await hold(14)
      const begun = await apiRequest(page, '/api/v1/social-connection-attempts', {
        method: 'POST',
        body: { provider: 'x', operation: 'CREATE_SET', creationVisibility: 'PRIVATE' },
      })
      expect(begun.status).toBeLessThan(300)
      const state = new URL(z.object({ url: z.string() }).parse(begun.body).url).searchParams.get(
        'oauth_token'
      )
      // Another account takes the last slot before the provider returns.
      await hold(1)
      const before = await profiles()
      const committed = await page.goto(
        getE2EUrl(`/integrations/social/x?oauth_token=${state}&oauth_verifier=fixture-verifier`)
      )
      expect(committed?.status()).toBe(403)
      await expect(page.getByText(limitMessage)).toBeVisible()
      expect(await profiles()).toEqual(before)
      const receipt = await db.query(
        'SELECT "exchangeStatus" FROM social_oauth_start WHERE state=$1',
        [state]
      )
      // The exchanged account is kept for recovery once a slot frees up.
      expect(
        z.array(z.object({ exchangeStatus: z.literal('EXCHANGED') })).parse(receipt.rows)
      ).toHaveLength(1)

      // At the limit, a new profile is refused before the provider is opened.
      await app.open('/settings/publishing-brands')
      await page.getByRole('button', { name: 'New workspace profile', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByRole('button', { name: 'X / Twitter', exact: true }).click()
      await dialog.getByRole('button', { name: 'Connect X account', exact: true }).click()
      await expect(dialog.getByText(limitMessage)).toBeVisible()
      expect(new URL(page.url()).pathname).toBe('/settings/publishing-brands')
      expect(await profiles()).toEqual(before)
    } finally {
      await db.query(
        'DELETE FROM channel_connection WHERE "organizationId"=$1 AND "externalAccountId" LIKE $2',
        [organizationId, 'held-%']
      )
      await unbindTestGoOrganization(organizationId)
      await provider.close()
    }
  }
)

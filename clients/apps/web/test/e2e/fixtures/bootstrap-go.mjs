import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import pg from 'pg'

const base = process.env.SOCIAL_GATE_API_URL ?? 'http://127.0.0.1:8180'
const serviceToken = process.env.PUBLISHING_SERVICE_TOKEN
const databaseURL = process.env.E2E_DATABASE_URL
const output = process.argv[2]
if (!output || !serviceToken || !databaseURL) {
  throw new Error(
    'Usage: PUBLISHING_SERVICE_TOKEN=… E2E_DATABASE_URL=… node test/e2e/fixtures/bootstrap-go.mjs <private-output-file>'
  )
}

// A signed-in owner of its own workspace, bound to a new social organization
// with the SQL of scripts/bind-social-tenant.ts.
const [userId, organizationId, sessionId] = [randomUUID(), randomUUID(), randomUUID()]
const name = `Social gate ${organizationId}`
const database = new pg.Client({ connectionString: databaseURL })
await database.connect()
let goOrganizationId
try {
  await database.query('BEGIN')
  await database.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "updatedAt") VALUES ($1, $2, $3, true, now())`,
    [userId, name, `social-gate-${userId}@example.test`]
  )
  await database.query(
    `INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $1, now())`,
    [organizationId, name]
  )
  await database.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', now())`,
    [randomUUID(), organizationId, userId]
  )
  await database.query(
    `INSERT INTO session (id, token, "userId", "activeOrganizationId", "expiresAt", "updatedAt")
     VALUES ($1, $2, $3, $4, now() + interval '1 hour', now())`,
    [sessionId, randomBytes(24).toString('base64url'), userId, organizationId]
  )
  goOrganizationId = (
    await database.query(
      `INSERT INTO "Organization" (id, name, "apiKey", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, now()) RETURNING id`,
      [name, randomBytes(24).toString('base64url')]
    )
  ).rows[0].id
  await database.query(
    `INSERT INTO social_tenant_binding ("organizationId", "goOrganizationId", "secretReference", "createdAt")
     VALUES ($1, $2, 'SOCIAL_API_KEY_GATE', now())`,
    [organizationId, goOrganizationId]
  )
  await database.query('COMMIT')
} finally {
  await database.end()
}

// The web's own path: the product API connects the account in process.
async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
      'X-Organization-ID': organizationId,
      'X-Session-ID': sessionId,
      'X-User-ID': userId,
    },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`)
  return response.json()
}
async function connect(code, provider = 'e2e') {
  const { url } = await post('/v1/social-oauth/begin', { provider })
  const state = new URL(url).searchParams.get('state')
  if (!state) throw new Error('Fake provider returned no OAuth state')
  const { id } = await post('/v1/social-oauth/exchange', { code, provider, state })
  if (typeof id !== 'string' || !id) throw new Error('The product API returned no destination ID')
  if (provider === 'youtube') {
    await post('/v1/social-oauth/remember', { provider, state, integrationId: id })
    await post('/v1/social-oauth/page', {
      provider,
      state,
      integrationId: id,
      accountId: 'fixture-channel',
      pageId: 'fixture-channel',
    })
  }
  return id
}
const destinationId = await connect('valid')
const expiredDestinationId = await connect('expired')
const tiktokDestinationId = await connect('valid', 'tiktok')
const youtubeDestinationId = await connect('valid', 'youtube')

await writeFile(
  output,
  JSON.stringify({
    destinationId,
    expiredDestinationId,
    goOrganizationId,
    tiktokDestinationId,
    youtubeDestinationId,
  }),
  {
    mode: 0o600,
  }
)
await chmod(output, 0o600)
process.stdout.write('Isolated social organization and fake destinations ready.\n')

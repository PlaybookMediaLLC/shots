import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'

type SessionClient = { cookie: string }
type SetCookieHeaders = Headers & { getSetCookie?: () => string[] }

const baseUrl = getLocalBaseUrl()
const testRunId = randomUUID()
const testPassword = 'LocalTenantIsolation2026!'
const organizationSchema = z.object({ id: z.string().min(1) }).passthrough()
const releaseSchema = z.object({ id: z.string().uuid(), title: z.string() })
const releaseResultSchema = z.object({ release: releaseSchema })
const releaseListSchema = z.object({ releases: z.array(releaseSchema) })
const assetResultSchema = z.object({ asset: z.object({ id: z.string().uuid() }) })
const apiKeyResultSchema = z.object({ apiKey: z.object({ id: z.string(), key: z.string().min(1) }) })
const campaignSchema = z.object({ id: z.string(), posts: z.array(z.object({ id: z.string() })) })
const campaignResultSchema = z.object({ campaign: campaignSchema, created: z.boolean() })
const campaignListSchema = z.object({ data: z.array(z.object({ id: z.string() })) })
const approvalListSchema = z.object({
  data: z.array(z.object({ campaign: z.object({ id: z.string() }), post: z.object({ id: z.string() }) })),
})
const onboardingRunSchema = z.object({ run: z.object({ id: z.string().min(1) }) })
const invitationSchema = z.object({ id: z.string().min(1) })
const voiceSettingsSchema = z.object({ workspace: z.object({ voiceNotes: z.boolean() }) })
const voiceNoteDetailSchema = z.object({
  deleted: z.boolean(),
  id: z.string().min(1),
  revision: z.number().int(),
  transcripts: z.array(z.object({ redacted: z.boolean() })),
})
const voiceTranscriptResultSchema = z.object({
  note: z.object({ revision: z.number().int() }),
  revision: z.object({ id: z.string().min(1) }),
})
/** The inbox page and the sync index both list `notes`. */
const voiceNoteListSchema = z.object({
  notes: z.array(z.object({ clientNoteId: z.string(), id: z.string() })),
})

type VoiceNote = { id: string; revision: number; revisionId: string }
type RouteCall = readonly [path: string, method: string, body?: unknown]

function getLocalBaseUrl(): string {
  const url = new URL(process.env.TENANT_TEST_BASE_URL ?? 'http://localhost:3000')
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Tenant tests only run locally.')
  return url.toString().replace(/\/$/, '')
}

function getResponseCookies(response: Response): string {
  const headers = response.headers as SetCookieHeaders
  const cookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  return cookies
    .map((value) => value.split(';', 1)[0] ?? '')
    .filter(Boolean)
    .join('; ')
}

function updateSessionCookie(client: SessionClient | undefined, response: Response): void {
  const cookie = getResponseCookies(response)
  if (client && cookie) client.cookie = cookie
}

async function request(path: string, init: RequestInit = {}, client?: SessionClient): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('origin', baseUrl)
  headers.set('x-request-id', `tenant-isolation:${testRunId}`)
  if (client?.cookie) headers.set('cookie', client.cookie)
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers })
  updateSessionCookie(client, response)
  return response
}

async function trpcMutation(
  path: string,
  input: unknown,
  client?: SessionClient,
  headers: Record<string, string> = {}
): Promise<Response> {
  return request(
    `/api/trpc/${path}`,
    {
      body: JSON.stringify({ json: input }),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    },
    client
  )
}

async function trpcJson(response: Response): Promise<unknown> {
  const payload = (await response.json()) as { result?: { data?: { json?: unknown } } }
  return payload.result?.data?.json ?? null
}

function assertStatus(response: Response, expected: number): void {
  assert.equal(response.status, expected, `Expected ${expected}, received ${response.status}.`)
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json()
}

function tenantEmail(label: string): string {
  return `tenant-${label}-${testRunId}@example.invalid`
}

async function createSession(label: string): Promise<SessionClient> {
  const email = tenantEmail(label)
  const signUpResponse = await request('/api/auth/sign-up/email', {
    body: JSON.stringify({ email, name: `Tenant ${label}`, password: testPassword }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  assertStatus(signUpResponse, 200)
  const signInResponse = await request('/api/auth/sign-in/email', {
    body: JSON.stringify({ email, password: testPassword }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  assertStatus(signInResponse, 200)
  const cookie = getResponseCookies(signInResponse)
  assert(cookie, `A session cookie was not issued for organization ${label}.`)
  return { cookie }
}

async function createOrganization(client: SessionClient, label: string): Promise<string> {
  const response = await request(
    '/api/auth/organization/create',
    {
      body: JSON.stringify({ name: `Tenant ${label} ${testRunId}`, slug: `tenant-${label}-${testRunId}` }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    },
    client
  )
  assertStatus(response, 200)
  const organization = organizationSchema.parse(await responseJson(response))
  const activeResponse = await request(
    '/api/auth/organization/set-active',
    {
      body: JSON.stringify({ organizationId: organization.id }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    },
    client
  )
  assertStatus(activeResponse, 200)
  return organization.id
}

async function createRelease(client: SessionClient, label: string): Promise<z.infer<typeof releaseSchema>> {
  const response = await request(
    '/api/tenant/releases',
    {
      body: JSON.stringify({ benefitStatement: `Benefit ${label}`, title: `Release ${label}` }),
      headers: { 'content-type': 'application/json', 'idempotency-key': `${testRunId}:${label}` },
      method: 'POST',
    },
    client
  )
  assertStatus(response, 201)
  return releaseResultSchema.parse(await responseJson(response)).release
}

async function createPendingAsset(client: SessionClient): Promise<string> {
  const response = await request(
    '/api/tenant/assets/upload-url',
    {
      body: JSON.stringify({ bytes: 1, contentType: 'image/png', fileName: 'tenant-test.png' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    },
    client
  )
  assertStatus(response, 201)
  return assetResultSchema.parse(await responseJson(response)).asset.id
}

const json = { 'content-type': 'application/json' }
/** A well-formed ID that names nothing, so a request passes validation and reaches the backend. */
const unknownCuid = 'cl0000000000000000000000'

async function createCampaign(client: SessionClient, label: string): Promise<z.infer<typeof campaignSchema>> {
  const create = () =>
    request(
      '/api/v1/campaigns',
      {
        body: JSON.stringify({
          name: `Campaign ${label}`,
          objective: `Objective ${label}`,
          posts: [{ channel: 'linkedin', copy: `Post ${label}` }],
        }),
        headers: { ...json, 'idempotency-key': `${testRunId}:campaign:${label}` },
        method: 'POST',
      },
      client
    )
  const created = await create()
  assertStatus(created, 201)
  const campaign = campaignResultSchema.parse(await responseJson(created)).campaign
  // A retry with the same key returns the same campaign, not a second one.
  const replayed = await create()
  assertStatus(replayed, 200)
  assert.equal(campaignResultSchema.parse(await responseJson(replayed)).campaign.id, campaign.id)
  const submitted = await request(
    `/api/v1/campaigns/${campaign.id}/review-requests`,
    { body: '{}', headers: json, method: 'POST' },
    client
  )
  assertStatus(submitted, 200)
  return campaign
}

/** Every way to name another workspace's campaign gets 404, and lists never include it. */
async function assertCampaignIsolation(
  credentials: { client?: SessionClient; headers?: Record<string, string> },
  ownCampaignId: string,
  other: z.infer<typeof campaignSchema>
): Promise<void> {
  const { client, headers = {} } = credentials
  const list = await request('/api/v1/campaigns', { headers }, client)
  assertStatus(list, 200)
  const campaigns = campaignListSchema.parse(await responseJson(list)).data
  assert(campaigns.some((campaign) => campaign.id === ownCampaignId))
  assert(!campaigns.some((campaign) => campaign.id === other.id))

  const queue = await request('/api/v1/approvals', { headers }, client)
  assertStatus(queue, 200)
  const pending = approvalListSchema.parse(await responseJson(queue)).data
  assert(pending.some((item) => item.campaign.id === ownCampaignId))
  assert(!pending.some((item) => item.campaign.id === other.id))

  assertStatus(await request(`/api/v1/campaigns/${other.id}`, { headers }, client), 404)
  for (const [path, body] of [
    [`/api/v1/campaigns/${other.id}/transitions`, { status: 'ARCHIVED' }],
    [`/api/v1/campaigns/${other.id}/review-requests`, { postIds: other.posts.map((post) => post.id) }],
    [`/api/v1/campaigns/${other.id}/posts/${other.posts[0]!.id}/schedule`, { channelConnectionId: unknownCuid }],
  ] as const) {
    const response = await request(
      path,
      { body: JSON.stringify(body), headers: { ...headers, ...json }, method: 'POST' },
      client
    )
    assertStatus(response, 404)
  }
}

/**
 * Approving is a person's decision: an API key is refused even on its own
 * data. A key with post:schedule reads the schedule, but cannot schedule copy
 * no one approved.
 */
async function assertApiKeyCannotDecide(apiKey: string, own: z.infer<typeof campaignSchema>): Promise<void> {
  const headers = { ...json, 'x-api-key': apiKey }
  const approve = await request(`/api/v1/campaigns/${own.id}/approvals`, {
    body: JSON.stringify({ decision: 'approve' }),
    headers,
    method: 'POST',
  })
  assertStatus(approve, 403)
  assertStatus(await request('/api/v1/scheduled-posts', { headers }), 200)
  const schedule = await request(`/api/v1/campaigns/${own.id}/posts/${own.posts[0]!.id}/schedule`, {
    body: JSON.stringify({ channelConnectionId: unknownCuid }),
    headers,
    method: 'POST',
  })
  assertStatus(schedule, 409)
  const transition = await request(`/api/v1/campaigns/${own.id}/transitions`, {
    body: JSON.stringify({ status: 'APPROVED' }),
    headers,
    method: 'POST',
  })
  assertStatus(transition, 403)
}

async function assertMemberDecisionIsolation(client: SessionClient, other: z.infer<typeof campaignSchema>) {
  const decision = await request(
    `/api/v1/campaigns/${other.id}/approvals`,
    { body: JSON.stringify({ decision: 'approve' }), headers: json, method: 'POST' },
    client
  )
  assertStatus(decision, 404)
  // Reading the schedule needs no fresh sign-in; it lists only this workspace.
  assertStatus(await request('/api/v1/scheduled-posts', {}, client), 200)
}

async function createApiKey(client: SessionClient): Promise<{ id: string; key: string }> {
  const response = await trpcMutation(
    'apiKey.create',
    { name: `tenant-${testRunId.slice(0, 20)}`, scopes: ['artifact:read', 'post:schedule', 'release:create'] },
    client
  )
  assertStatus(response, 200)
  return apiKeyResultSchema.parse(await trpcJson(response)).apiKey
}

async function assertSessionIsolation(
  client: SessionClient,
  ownReleaseId: string,
  otherReleaseId: string,
  otherOrganizationId: string,
  otherAssetId: string
): Promise<void> {
  const listResponse = await request(`/api/tenant/releases?organizationId=${otherOrganizationId}`, {}, client)
  assertStatus(listResponse, 200)
  const releases = releaseListSchema.parse(await responseJson(listResponse)).releases
  assert(releases.some((release) => release.id === ownReleaseId))
  assert(!releases.some((release) => release.id === otherReleaseId))

  const downloadResponse = await request(`/api/tenant/assets/${otherAssetId}/download-url`, {}, client)
  assertStatus(downloadResponse, 404)
  const completeResponse = await request(
    `/api/tenant/assets/${otherAssetId}/complete`,
    { body: JSON.stringify({}), headers: { 'content-type': 'application/json' }, method: 'POST' },
    client
  )
  assertStatus(completeResponse, 404)
}

async function assertApiKeyIsolation(
  client: SessionClient,
  apiKey: { id: string; key: string },
  ownReleaseId: string,
  otherReleaseId: string,
  otherOrganizationId: string,
  otherAssetId: string
): Promise<void> {
  const headers = { 'x-api-key': apiKey.key }
  const listResponse = await request(`/api/tenant/releases?organizationId=${otherOrganizationId}`, { headers })
  assertStatus(listResponse, 200)
  const releases = releaseListSchema.parse(await responseJson(listResponse)).releases
  assert(releases.some((release) => release.id === ownReleaseId))
  assert(!releases.some((release) => release.id === otherReleaseId))

  const downloadResponse = await request(`/api/tenant/assets/${otherAssetId}/download-url`, { headers })
  assertStatus(downloadResponse, 404)
  const revokeResponse = await trpcMutation('apiKey.revoke', { keyId: apiKey.id }, client)
  assertStatus(revokeResponse, 200)
  const revokedResponse = await request('/api/tenant/releases', { headers })
  assertStatus(revokedResponse, 403)
}

/**
 * Start an onboarding run (docs/rfcs/032). The site is unreachable on
 * purpose: the run still completes, so no external request is made.
 */
async function createOnboardingRun(client: SessionClient, label: string): Promise<string> {
  const response = await request(
    '/api/v1/onboarding-runs',
    {
      body: JSON.stringify({ url: `https://tenant-${label}.invalid/` }),
      headers: { 'content-type': 'application/json', 'idempotency-key': `${testRunId}:${label}` },
      method: 'POST',
    },
    client
  )
  assertStatus(response, 201)
  return onboardingRunSchema.parse(await responseJson(response)).run.id
}

/** Another workspace's run, its pages' findings, and its ICP are invisible and untouchable. */
async function assertOnboardingIsolation(
  client: SessionClient,
  ownRunId: string,
  otherRunId: string
): Promise<void> {
  assertStatus(await request(`/api/v1/onboarding-runs/${ownRunId}`, {}, client), 200)
  for (const [path, method] of [
    [`/api/v1/onboarding-runs/${otherRunId}`, 'GET'],
    [`/api/v1/onboarding-runs/${otherRunId}/enrichment`, 'GET'],
    [`/api/v1/onboarding-runs/${otherRunId}/cancel`, 'POST'],
    [`/api/v1/onboarding-runs/${otherRunId}/rerun`, 'POST'],
  ] as const) {
    assertStatus(await request(path, { method }, client), 404)
  }
}

/** Fixture setup the API cannot do, such as a plan or a verified address, in the local database. */
async function withFixtureDatabase(run: (database: Pool) => Promise<void>): Promise<void> {
  const connection = process.env.HOST_DATABASE_URL
  assert(connection, 'HOST_DATABASE_URL is required to prepare the fixture accounts and workspaces.')
  const url = new URL(connection)
  url.searchParams.delete('schema')
  const database = new Pool({ connectionString: url.toString() })
  try {
    await run(database)
  } finally {
    await database.end()
  }
}

/**
 * There is no free plan, so each fixture workspace gets Pro directly in the
 * local database, the same way the e2e framework does.
 */
async function grantProPlan(organizationIds: string[]): Promise<void> {
  await withFixtureDatabase(async (database) => {
    for (const organizationId of organizationIds) {
      await database.query(
        `INSERT INTO workspace_entitlement ("organizationId", plan, status, "updatedAt")
         VALUES ($1, 'pro', 'active', now())
         ON CONFLICT ("organizationId") DO UPDATE SET plan = 'pro', status = 'active', "updatedAt" = now()`,
        [organizationId]
      )
    }
  })
}

/** A creator its owner invited into `organizationId`, signed in with that workspace active. */
async function addMember(owner: SessionClient, organizationId: string, label: string): Promise<SessionClient> {
  const email = tenantEmail(label)
  const invited = await request(
    '/api/auth/organization/invite-member',
    { body: JSON.stringify({ email, organizationId, role: 'creator' }), headers: json, method: 'POST' },
    owner
  )
  assertStatus(invited, 200)
  const invitation = invitationSchema.parse(await responseJson(invited))
  const member = await createSession(label)
  // Accepting needs a verified address, as in production; the e2e framework does the same.
  await withFixtureDatabase(async (database) => {
    const verified = await database.query('UPDATE "user" SET "emailVerified" = true WHERE email = $1', [email])
    assert.equal(verified.rowCount, 1)
  })
  const accepted = await request(
    '/api/auth/organization/accept-invitation',
    { body: JSON.stringify({ invitationId: invitation.id }), headers: json, method: 'POST' },
    member
  )
  assertStatus(accepted, 200)
  const active = await request(
    '/api/auth/organization/set-active',
    { body: JSON.stringify({ organizationId }), headers: json, method: 'POST' },
    member
  )
  assertStatus(active, 200)
  return member
}

const voiceRoot = '/api/v1/voice'

/** Voice notes are off until an owner or admin turns them on (plan 6.9). */
async function enableVoiceNotes(owner: SessionClient): Promise<void> {
  const response = await request(
    `${voiceRoot}/settings/workspace`,
    { body: JSON.stringify({ voiceNotes: true }), headers: json, method: 'PUT' },
    owner
  )
  assertStatus(response, 200)
  assert.equal(voiceSettingsSchema.parse(await responseJson(response)).workspace.voiceNotes, true)
}

/** A note with its on-device transcript, as the phone syncs it. */
async function createVoiceNote(client: SessionClient, label: string): Promise<VoiceNote> {
  const created = await request(
    `${voiceRoot}/notes`,
    {
      body: JSON.stringify({
        clientNoteId: `${testRunId}:${label}`,
        recordedAt: new Date().toISOString(),
        recordedTimeZone: 'Europe/Berlin',
        title: `Voice ${label}`,
      }),
      headers: json,
      method: 'POST',
    },
    client
  )
  assertStatus(created, 201)
  const { id } = voiceNoteDetailSchema.parse(await responseJson(created))
  const transcribed = await request(
    `${voiceRoot}/notes/${id}/transcripts`,
    {
      body: JSON.stringify({
        clientRevisionId: `${testRunId}:${label}`,
        origin: 'on_device',
        segments: [{ endMs: 1_000, startMs: 0, text: `Private ${label}` }],
        text: `Private ${label}`,
      }),
      headers: json,
      method: 'POST',
    },
    client
  )
  assertStatus(transcribed, 201)
  const result = voiceTranscriptResultSchema.parse(await responseJson(transcribed))
  return { id, revision: result.note.revision, revisionId: result.revision.id }
}

/** Every voice route that names a note, with a body that passes validation; the delete is last. */
function voiceNoteRoutes(note: VoiceNote): RouteCall[] {
  const path = `${voiceRoot}/notes/${note.id}`
  return [
    [path, 'GET'],
    [path, 'PATCH', { expectedRevision: note.revision, title: 'Taken' }],
    [
      `${path}/transcripts`,
      'POST',
      { clientRevisionId: `${testRunId}:taken`, origin: 'user_edit', segments: [], text: 'Taken' },
    ],
    [`${path}/transcripts/${note.revisionId}/redact`, 'POST'],
    [`${path}/runs/0/upload`, 'POST', { bytes: 44, contentType: 'audio/wav', sha256: 'a'.repeat(64), startOffsetMs: 0 }],
    [`${path}/runs/0/complete`, 'POST'],
    [`${path}/runs/0/audio`, 'GET'],
    [`${path}/audio`, 'DELETE'],
    [`${path}/draft`, 'POST', { intent: 'saved_idea', transcriptRevisionId: note.revisionId }],
    [
      `${path}/command/confirm`,
      'POST',
      { channelConnectionId: unknownCuid, localTime: '09:00', text: 'Taken', timeZone: 'Europe/Berlin' },
    ],
    [path, 'DELETE'],
  ]
}

function routeInit([, method, body]: RouteCall, headers: Record<string, string> = {}): RequestInit {
  return body === undefined
    ? { headers, method }
    : { body: JSON.stringify(body), headers: { ...headers, ...json }, method }
}

async function voiceNoteIds(client: SessionClient, path: string): Promise<z.infer<typeof voiceNoteListSchema>['notes']> {
  const response = await request(path, {}, client)
  assertStatus(response, 200)
  return voiceNoteListSchema.parse(await responseJson(response)).notes
}

/**
 * A voice note is private to the member who recorded it (plan gate 2):
 * anyone else, an owner of the same workspace or a member of another, gets
 * 404 from every route that names it and never finds it in the inbox or the
 * sync index.
 */
async function assertVoiceNoteIsolation(client: SessionClient, own: VoiceNote, other: VoiceNote): Promise<void> {
  for (const path of [`${voiceRoot}/notes`, `${voiceRoot}/notes/index`]) {
    const ids = (await voiceNoteIds(client, path)).map((note) => note.id)
    assert(ids.includes(own.id), `${path} lists the member's own note.`)
    assert(!ids.includes(other.id), `${path} lists someone else's note.`)
  }
  for (const call of voiceNoteRoutes(other)) {
    const [path, method] = call
    const response = await request(path, routeInit(call), client)
    assert.equal(response.status, 404, `${method} ${path} answered ${response.status}, not 404.`)
  }
}

/** Nothing the refused requests sent changed the note: same revision, live, no transcript redacted. */
async function assertVoiceNoteUnchanged(owner: SessionClient, note: VoiceNote): Promise<void> {
  const response = await request(`${voiceRoot}/notes/${note.id}`, {}, owner)
  assertStatus(response, 200)
  const detail = voiceNoteDetailSchema.parse(await responseJson(response))
  assert.equal(detail.revision, note.revision)
  assert.equal(detail.deleted, false)
  assert(detail.transcripts.every((transcript) => !transcript.redacted))
}

/**
 * Every voice route is session-only: a note belongs to a member, and an API
 * key has none. A valid key of the note's own workspace is refused, and
 * nothing it sent takes effect.
 */
async function assertApiKeyCannotUseVoice(apiKey: string, owner: SessionClient, own: VoiceNote): Promise<void> {
  const keyNoteId = `${testRunId}:api-key`
  const calls: RouteCall[] = [
    [`${voiceRoot}/settings`, 'GET'],
    [`${voiceRoot}/settings/workspace`, 'PUT', { voiceNotes: false }],
    [`${voiceRoot}/settings/member`, 'PUT', { remoteTextConsent: true }],
    [`${voiceRoot}/notes/index`, 'GET'],
    [`${voiceRoot}/notes`, 'GET'],
    [
      `${voiceRoot}/notes`,
      'POST',
      { clientNoteId: keyNoteId, recordedAt: new Date().toISOString(), recordedTimeZone: 'Europe/Berlin' },
    ],
    ...voiceNoteRoutes(own),
  ]
  for (const call of calls) {
    const [path, method] = call
    const response = await request(path, routeInit(call, { 'x-api-key': apiKey }))
    assert.equal(response.status, 403, `${method} ${path} with an API key answered ${response.status}, not 403.`)
  }
  const settings = await request(`${voiceRoot}/settings`, {}, owner)
  assertStatus(settings, 200)
  assert.equal(voiceSettingsSchema.parse(await responseJson(settings)).workspace.voiceNotes, true)
  const index = await voiceNoteIds(owner, `${voiceRoot}/notes/index`)
  assert(!index.some((note) => note.clientNoteId === keyNoteId), 'An API key created a voice note.')
  await assertVoiceNoteUnchanged(owner, own)
}

async function main(): Promise<void> {
  const clientA = await createSession('a')
  const clientB = await createSession('b')
  const organizationA = await createOrganization(clientA, 'a')
  const organizationB = await createOrganization(clientB, 'b')
  await grantProPlan([organizationA, organizationB])
  const releaseA = await createRelease(clientA, 'a')
  const releaseB = await createRelease(clientB, 'b')
  const assetA = await createPendingAsset(clientA)
  const assetB = await createPendingAsset(clientB)
  const campaignA = await createCampaign(clientA, 'a')
  const campaignB = await createCampaign(clientB, 'b')
  const apiKeyA = await createApiKey(clientA)

  await assertSessionIsolation(clientA, releaseA.id, releaseB.id, organizationB, assetB)
  await assertSessionIsolation(clientB, releaseB.id, releaseA.id, organizationA, assetA)
  await assertCampaignIsolation({ client: clientA }, campaignA.id, campaignB)
  await assertCampaignIsolation({ client: clientB }, campaignB.id, campaignA)
  await assertCampaignIsolation({ headers: { 'x-api-key': apiKeyA.key } }, campaignA.id, campaignB)
  await assertMemberDecisionIsolation(clientA, campaignB)
  await assertApiKeyCannotDecide(apiKeyA.key, campaignA)
  // Voice notes are private to the member who recorded them, even from the workspace owner.
  const memberA = await addMember(clientA, organizationA, 'a-member')
  await enableVoiceNotes(clientA)
  await enableVoiceNotes(clientB)
  const voiceA = await createVoiceNote(clientA, 'a')
  const voiceMemberA = await createVoiceNote(memberA, 'a-member')
  const voiceB = await createVoiceNote(clientB, 'b')
  await assertVoiceNoteIsolation(memberA, voiceMemberA, voiceA)
  await assertVoiceNoteIsolation(clientA, voiceA, voiceMemberA)
  await assertVoiceNoteIsolation(clientB, voiceB, voiceA)
  await assertVoiceNoteIsolation(clientA, voiceA, voiceB)
  await assertApiKeyCannotUseVoice(apiKeyA.key, clientA, voiceA)
  await assertVoiceNoteUnchanged(memberA, voiceMemberA)
  await assertVoiceNoteUnchanged(clientB, voiceB)
  await assertApiKeyIsolation(clientA, apiKeyA, releaseA.id, releaseB.id, organizationB, assetB)
  const runA = await createOnboardingRun(clientA, 'a')
  const runB = await createOnboardingRun(clientB, 'b')
  await assertOnboardingIsolation(clientA, runA, runB)
  await assertOnboardingIsolation(clientB, runB, runA)
  console.info(`Tenant isolation passed for local run ${testRunId}.`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

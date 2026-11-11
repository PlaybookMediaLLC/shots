import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, Module } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'
import { type RouteContract, routeContractSchema } from '@/lib/api/contract'
import { contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { contentDraftSettingsSchema } from '@/lib/api/contracts/content-draft-platform'
import * as founderHubVoice from '@/lib/api/contracts/founder-hub-voice'
import * as voiceNotes from '@/lib/api/contracts/voice'
import * as voiceActions from '@/lib/api/contracts/voice-actions'
import * as voice from '@/lib/api/contracts/voice-schemas'
import { openApiSpec } from '@/lib/api/openapi'
import { createLinks, CREATE_LINKS, platformArea, VOICE_NOTES } from '@/lib/platform/navigation'
import { recordedLabel, reviewParts } from '@/lib/voice/client'

// The route modules import 'server-only', which throws outside the
// react-server condition. Stub it so this file runs under the plain runner.
const localRequire = createRequire(__filename)
const serverOnlyPath = localRequire.resolve('server-only')
const serverOnlyStub = new Module(serverOnlyPath)
serverOnlyStub.loaded = true
localRequire.cache[serverOnlyPath] = serverOnlyStub

const voiceContracts = Object.entries({ ...voiceNotes, ...voiceActions }).filter(
  ([, value]) => routeContractSchema.safeParse(value).success
) as [string, RouteContract][]

const note = {
  id: 'cnote000000000000000000001',
  clientNoteId: '4c7f2f1e-3b7a-4d2a-9f43-1b7a5e2c9d10',
  title: '',
  projectId: null,
  recordedAt: '2026-11-11T09:00:00.123456789Z',
  recordedTimeZone: 'Europe/Berlin',
  receivedAt: '2026-11-11T09:01:00Z',
  locale: 'en-US',
  durationMs: 61_000,
  audioUploadConsent: false,
  revision: 3,
  deleted: false,
  deletedAt: null,
  currentTranscriptRevisionId: null,
  transcriptConflict: false,
  createdAt: '2026-11-11T09:01:00Z',
  updatedAt: '2026-11-11T09:01:00Z',
}

test('every voice route is session-only: API keys are refused, and the spec says so', () => {
  assert.equal(voiceContracts.length, 17, 'section 4 of the implementation plan has 17 rows')
  const paths = openApiSpec.paths as Record<string, Record<string, Record<string, unknown>>>
  for (const [name, contract] of voiceContracts) {
    assert.match(contract.path, /^\/api\/v1\/voice\//, name)
    assert.ok(
      contract.access && !('apiKeyScope' in contract.access),
      `${name} must refuse API keys`
    )
    const file = `app${contract.path.replace(/\{(\w+)\}/g, '[$1]')}/route.ts`
    // memberAccess answers 403 to an X-API-Key before it reads a session.
    assert.match(
      readFileSync(join(process.cwd(), file), 'utf8'),
      new RegExp(`auth: memberAccess\\(${name}\\.access\\)`),
      name
    )
    const operation = paths[contract.path]?.[contract.method.toLowerCase()]
    assert.deepEqual(operation?.security, [{ workspaceSession: [] }], name)
  }
  assert.equal(
    voiceNotes.updateVoiceWorkspaceSettingsContract.access.permission,
    'workspace:update'
  )
  assert.equal(voiceActions.createVoiceDraftContract.access.feature, 'content:drafts')
})

test('voice responses take what the Go backend sends, including null slices', () => {
  const detail = voice.voiceNoteDetailSchema.parse({
    ...note,
    command: null,
    runs: null,
    transcripts: [
      {
        id: 'crev0000000000000000000001',
        clientRevisionId: 'r1',
        parentId: null,
        origin: 'on_device',
        locale: null,
        engine: null,
        text: 'Ship it',
        segments: [{ endMs: 900, startMs: 0, text: 'Ship it' }],
        redacted: false,
        createdByUserId: 'user_1',
        createdAt: '2026-11-11T09:01:00Z',
      },
    ],
  })
  assert.deepEqual(detail.runs, [])
  assert.equal(detail.transcripts[0]?.segments[0]?.approximate, undefined)
  const page = voice.voiceNotePageSchema.parse({ nextCursor: null, notes: null })
  assert.deepEqual(page.notes, [])
  const settings = voice.voiceSettingsSchema.parse({
    canManage: false,
    limits: {
      maxCommandChars: 500,
      maxNoteMs: 1_800_000,
      maxTranscriptChars: 100_000,
      minNoteMs: 1_000,
      warnAtMs: 1_500_000,
    },
    member: { remoteTextConsentAt: null, voiceCommands: false },
    minAppVersion: '1.0.0',
    switches: { audioUpload: true, confirm: true, drafts: true, notes: true, parse: true },
    workspace: {
      audioUpload: false,
      draftGeneration: false,
      voiceCommands: false,
      voiceNotes: false,
    },
  })
  assert.equal(settings.workspace.voiceNotes, false)
  assert.ok(!voice.voiceNoteSchema.safeParse({ ...note, recordedAt: 'yesterday' }).success)
})

test('voice request bodies reject unknown fields and invalid values', () => {
  const create = {
    clientNoteId: note.clientNoteId,
    recordedAt: '2026-11-11T10:00:00+01:00',
    recordedTimeZone: 'Europe/Berlin',
  }
  assert.ok(voice.voiceNoteCreateSchema.safeParse(create).success)
  assert.ok(voice.voiceNoteCreateSchema.safeParse({ ...create, projectId: null }).success)
  assert.ok(!voice.voiceNoteCreateSchema.safeParse({ ...create, ownerUserId: 'u2' }).success)
  assert.ok(!voice.voiceNoteCreateSchema.safeParse({ ...create, recordedAt: '' }).success)
  const transcript = { clientRevisionId: 'r2', origin: 'user_edit', segments: [], text: 'Hi' }
  assert.ok(voice.voiceTranscriptCreateSchema.safeParse(transcript).success)
  assert.ok(!voice.voiceTranscriptCreateSchema.safeParse({ ...transcript, origin: 'web' }).success)
  assert.ok(!voice.voiceWorkspaceFlagsInputSchema.safeParse({ voiceNotes: 'yes' }).success)
  assert.ok(!voice.voiceMemberChoicesInputSchema.safeParse({ consent: true }).success)
  const draft = { intent: 'launch_post', transcriptRevisionId: 'crev0000000000000000000001' }
  assert.ok(voice.voiceDraftInputSchema.safeParse(draft).success)
  assert.ok(!voice.voiceDraftInputSchema.safeParse({ ...draft, intent: 'publish_now' }).success)
  assert.equal(
    voiceActions.getVoiceRunAudioContract.params.parse({ id: note.id, runIndex: '2' }).runIndex,
    2
  )
  assert.ok(
    !voiceActions.getVoiceRunAudioContract.params.safeParse({ id: note.id, runIndex: '-1' }).success
  )
})

test('the SDK calls each voice route on the Go product API', async () => {
  const requests: string[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      const url = new URL(String(input))
      requests.push(`${init?.method} ${url.pathname}${url.search}`)
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      // A replayed create answers 200 with the stored record.
      return Response.json(
        { ok: true },
        { status: url.pathname.endsWith('/transcripts') ? 200 : 201 }
      )
    }
  )
  assert.deepEqual(await sdk.createVoiceNote({}), { body: { ok: true }, created: true })
  assert.deepEqual(await sdk.addVoiceTranscript('n/1', {}), { body: { ok: true }, created: false })
  assert.equal(await sdk.deleteVoiceNote('n1'), undefined)
  assert.equal(await sdk.deleteVoiceAudio('n1'), undefined)
  await sdk.getVoiceSettings()
  await sdk.updateVoiceWorkspaceSettings({})
  await sdk.updateVoiceMemberSettings({})
  await sdk.listVoiceNoteIndex()
  await sdk.listVoiceNotes({})
  await sdk.listVoiceNotes({ cursor: 'c 1', limit: 20 })
  await sdk.getVoiceNote('n1')
  await sdk.updateVoiceNote('n1', {})
  await sdk.redactVoiceTranscript('n1', 'r1')
  await sdk.createVoiceRunUpload('n1', 0, {})
  await sdk.completeVoiceRun('n1', 0)
  await sdk.getVoiceRunAudio('n1', 0)
  await sdk.createVoiceDraft('n1', {})
  await sdk.confirmVoiceCommand('n1', {})
  assert.deepEqual(requests, [
    'POST /v1/voice/notes',
    'POST /v1/voice/notes/n%2F1/transcripts',
    'DELETE /v1/voice/notes/n1',
    'DELETE /v1/voice/notes/n1/audio',
    'GET /v1/voice/settings',
    'PUT /v1/voice/settings/workspace',
    'PUT /v1/voice/settings/member',
    'GET /v1/voice/notes/index',
    'GET /v1/voice/notes',
    'GET /v1/voice/notes?cursor=c+1&limit=20',
    'GET /v1/voice/notes/n1',
    'PATCH /v1/voice/notes/n1',
    'POST /v1/voice/notes/n1/transcripts/r1/redact',
    'POST /v1/voice/notes/n1/runs/0/upload',
    'POST /v1/voice/notes/n1/runs/0/complete',
    'GET /v1/voice/notes/n1/runs/0/audio',
    'POST /v1/voice/notes/n1/draft',
    'POST /v1/voice/notes/n1/command/confirm',
  ])
})

test('numbers and names are marked for review, but not the word that starts a sentence', () => {
  const flagged = reviewParts('We shipped Acme Search 2.0 on March 3. It costs $40, says I.')
    .filter((part) => part.flagged)
    .map((part) => part.text)
  assert.deepEqual(flagged, ['Acme', 'Search', '2.0', 'March', '3', '40'])
  assert.equal(
    reviewParts('plain words only')
      .map((part) => part.text)
      .join(''),
    'plain words only'
  )
})

test('a note shows when it was recorded in its own zone, and survives a zone the browser lacks', () => {
  assert.match(recordedLabel(note), /\(Europe\/Berlin\) · 1:01$/)
  assert.match(
    recordedLabel({ ...note, durationMs: null, recordedTimeZone: 'Mars/Base' }),
    /\(Mars\/Base\)$/
  )
})

test('Create lists Voice notes only while the workspace has them on', () => {
  assert.deepEqual(createLinks(false), CREATE_LINKS)
  assert.deepEqual(createLinks(true).at(-1), VOICE_NOTES)
  assert.equal(platformArea(VOICE_NOTES.href), 'create')
})

test('a draft keeps its voice source, and drafts settings default to self-approval', () => {
  const settings = contentDraftSettingsSchema.parse({
    postingSlots: [],
    requireApproval: true,
    timeZone: 'UTC',
  })
  assert.equal(settings.allowSelfApproval, true)
  assert.equal(
    contentDraftSettingsSchema.parse({ ...settings, allowSelfApproval: false }).allowSelfApproval,
    false
  )
  const source = contentDraftSchema.shape.sourceVoiceRevisionId
  assert.equal(source.parse(undefined), null)
  assert.equal(source.parse('crev0000000000000000000001'), 'crev0000000000000000000001')
})

// The Founder Hub gateway's voice routes (/api/founder-hub/voice/<suffix>).

const founderHubContracts = Object.entries(founderHubVoice).filter(
  ([, value]) => routeContractSchema.safeParse(value).success
) as [string, RouteContract][]

test('each Founder Hub voice contract is its voice contract at the gateway path, kept private', () => {
  const voiceByPath = new Map(
    voiceContracts.map(([, contract]) => [`${contract.method} ${contract.path}`, contract])
  )
  assert.equal(founderHubContracts.length, voiceContracts.length - 1)
  for (const [name, contract] of founderHubContracts) {
    const source = voiceByPath.get(
      `${contract.method} ${contract.path.replace('/api/founder-hub/voice/', '/api/v1/voice/')}`
    )
    assert.ok(source, `${name} has no voice contract`)
    assert.equal(contract.name, `founder-hub.${source.name}`)
    for (const schema of ['body', 'headers', 'output', 'params', 'query'] as const)
      assert.equal(contract[schema], source[schema], `${name} ${schema}`)
    assert.equal(contract.status, source.status, name)
    // Like every Founder Hub contract: no public docs; the route enforces the voice access.
    assert.equal(contract.access, undefined, name)
    assert.equal(contract.docs, undefined, name)
    const file = `app${contract.path.replace(/\{(\w+)\}/g, '[$1]')}/route.ts`
    assert.match(
      readFileSync(join(process.cwd(), file), 'utf8'),
      /auth: async \(\{ request \}\) =>\s+requireFounderHubMemberAccess\(request\.headers, \w+Contract\.access\)/,
      name
    )
  }
  const workspace = voiceNotes.updateVoiceWorkspaceSettingsContract.path
  assert.ok(!founderHubContracts.some(([, contract]) => contract.path.endsWith('/workspace')))
  assert.ok(
    !existsSync(join(process.cwd(), `app${workspace}/route.ts`.replace('/v1/', '/founder-hub/')))
  )
})

const serviceToken = randomBytes(24).toString('hex')
const workspaceId = '6f1c0d8e-9a43-4f7e-8f6a-2b1d3c4e5f60'
const otherWorkspaceId = '0b6a8e5c-3d2f-4c1b-9a7e-5f4d3c2b1a09'
const spoken = 'PRIVATE spoken words'
const revisionId = 'crev0000000000000000000001'

const voiceSettings = {
  canManage: false,
  limits: { maxCommandChars: 500, maxNoteMs: 1, maxTranscriptChars: 1, minNoteMs: 1, warnAtMs: 1 },
  member: { remoteTextConsentAt: null, voiceCommands: false },
  minAppVersion: '1.0.0',
  switches: { audioUpload: true, confirm: true, drafts: true, notes: true, parse: true },
  workspace: { audioUpload: true, draftGeneration: true, voiceCommands: true, voiceNotes: true },
}
const revision = {
  id: revisionId,
  clientRevisionId: 'r1',
  parentId: null,
  origin: 'on_device',
  locale: null,
  engine: null,
  text: spoken,
  segments: null,
  redacted: false,
  createdByUserId: 'user_hub',
  createdAt: '2026-11-11T09:01:00Z',
}
const command = {
  id: 'ccmd00000000000000000001',
  transcriptRevisionId: revisionId,
  status: 'confirmed',
  action: 'schedule',
  platform: null,
  text: spoken,
  localTime: null,
  timeZone: 'UTC',
  scheduledFor: null,
  channelConnectionId: null,
  candidates: null,
  guessed: null,
  flags: null,
  addedWords: null,
  notice: null,
  contentDraftId: null,
  scheduledPostId: null,
  failureReason: null,
  expiresAt: null,
}
const detail = { ...note, title: spoken, transcripts: [revision], runs: null, command: null }
const run = {
  runIndex: 2,
  startOffsetMs: 0,
  durationMs: 900,
  sampleRateHz: 44_100,
  contentType: 'audio/aac',
  bytes: 10,
  sha256: '00',
  status: 'available',
}
const id = note.id

/** One voice operation: its path suffix, request, and what the Go backend answers. */
type VoiceOperation = {
  answer?: unknown
  body?: unknown
  file: string
  goStatus?: number
  method: string
  params?: Record<string, string>
  suffix: string
}

const operations: VoiceOperation[] = [
  { method: 'GET', suffix: 'settings', file: 'settings', answer: voiceSettings },
  {
    method: 'PUT',
    suffix: 'settings/member',
    file: 'settings/member',
    body: { remoteTextConsent: true },
    answer: voiceSettings,
  },
  {
    method: 'GET',
    suffix: 'notes/index',
    file: 'notes/index',
    answer: { notes: [{ id, clientNoteId: note.clientNoteId, revision: 3, deleted: true }] },
  },
  {
    method: 'GET',
    suffix: 'notes?limit=5&cursor=abc',
    file: 'notes',
    answer: { notes: [{ ...note, excerpt: spoken }], nextCursor: 'next' },
  },
  {
    method: 'POST',
    suffix: 'notes',
    file: 'notes',
    body: { clientNoteId: note.clientNoteId, recordedAt: note.recordedAt, recordedTimeZone: 'UTC' },
    answer: detail,
    goStatus: 201,
  },
  { method: 'GET', suffix: `notes/${id}`, file: 'notes/[id]', params: { id }, answer: detail },
  {
    method: 'PATCH',
    suffix: `notes/${id}`,
    file: 'notes/[id]',
    params: { id },
    body: { expectedRevision: 3, title: spoken },
    answer: detail,
  },
  { method: 'DELETE', suffix: `notes/${id}`, file: 'notes/[id]', params: { id }, goStatus: 204 },
  {
    method: 'POST',
    suffix: `notes/${id}/transcripts`,
    file: 'notes/[id]/transcripts',
    params: { id },
    body: { clientRevisionId: 'r1', origin: 'on_device', segments: [], text: spoken },
    answer: { revision, note, command },
  },
  {
    method: 'POST',
    suffix: `notes/${id}/transcripts/${revisionId}/redact`,
    file: 'notes/[id]/transcripts/[revisionId]/redact',
    params: { id, revisionId },
    answer: revision,
  },
  {
    method: 'POST',
    suffix: `notes/${id}/runs/2/upload`,
    file: 'notes/[id]/runs/[runIndex]/upload',
    params: { id, runIndex: '2' },
    body: { contentType: 'audio/aac', bytes: 10, sha256: '00', startOffsetMs: 0 },
    answer: {
      url: 'https://storage.example.test/put',
      method: 'PUT',
      headers: { 'Content-Length': '10' },
      expiresAt: '2026-11-11T10:00:00Z',
    },
  },
  {
    method: 'POST',
    suffix: `notes/${id}/runs/2/complete`,
    file: 'notes/[id]/runs/[runIndex]/complete',
    params: { id, runIndex: '2' },
    answer: run,
  },
  {
    method: 'GET',
    suffix: `notes/${id}/runs/2/audio`,
    file: 'notes/[id]/runs/[runIndex]/audio',
    params: { id, runIndex: '2' },
    answer: { url: 'https://storage.example.test/play', expiresAt: '2026-11-11T10:00:00Z' },
  },
  {
    method: 'DELETE',
    suffix: `notes/${id}/audio`,
    file: 'notes/[id]/audio',
    params: { id },
    goStatus: 204,
  },
  {
    method: 'POST',
    suffix: `notes/${id}/draft`,
    file: 'notes/[id]/draft',
    params: { id },
    body: { intent: 'launch_post', transcriptRevisionId: revisionId },
    answer: { contentDraftId: 'cdraft000000000000000001' },
  },
  {
    method: 'POST',
    suffix: `notes/${id}/command/confirm`,
    file: 'notes/[id]/command/confirm',
    params: { id },
    body: {
      text: spoken,
      channelConnectionId: 'cconn0000000000000000001',
      localTime: '2026-11-12T09:00',
      timeZone: 'UTC',
    },
    answer: { command, outcome: 'draft', contentDraftId: null, scheduledPostId: null },
  },
]

/** What one call to the Go backend carried. */
type BackendCall = { body: string | null; headers: Headers; method: string; url: URL }

/** The person's Founder Hub authority snapshot: a creator in one workspace. */
function founderHubSnapshot(role: string) {
  const identity = {
    emailVerified: true,
    createdAt: '2026-11-01T00:00:00Z',
    user: { id: 'user_hub', email: 'hub@example.test', name: 'Hub', image: null },
    accountUserId: '3d8b1f8e-2c4a-4b6e-9f1d-7a5c3e2b1d40',
  }
  const member = { ...identity, role, deniedPermissions: [] }
  return {
    ...identity,
    revision: '1',
    sessionId: 'session_hub',
    expiresAt: '2026-11-12T00:00:00Z',
    workspaces: [
      {
        organizationId: 'org_hub',
        workspaceId,
        ownerUserId: identity.accountUserId,
        owner: member,
        members: [member],
        name: 'Hub',
        role,
        deniedPermissions: [],
        features: {},
      },
    ],
  }
}

/**
 * Fake the Go backend, the browser session and Founder Hub token verification.
 * `voice` answers the `/v1/voice` calls; everything a route logs is captured.
 */
async function voiceHarness(
  t: test.TestContext,
  options: {
    role?: string
    session?: () => Response
    voice?: (call: BackendCall) => Response
  } = {}
) {
  process.env.PUBLISHING_API_URL = 'http://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'backend-token'
  process.env.SHOTS_AUTH_SERVICE_TOKEN = serviceToken
  process.env.PLATFORM_CONTENT_DRAFTS = 'enabled'
  const { auth } = await import('@/lib/auth/server')
  const { getAuthBaseUrl } = await import('@/lib/auth/environment')
  const audience = new URL('/api/founder-hub', getAuthBaseUrl()).toString()
  const claims = {
    sub: 'user_hub',
    sid: 'session_hub',
    azp: 'shots-founder-hub',
    aud: audience,
    scope: 'openid founder-hub offline_access',
  }
  const tokens: Record<string, unknown> = {
    good: claims,
    'wrong-azp': { ...claims, azp: 'another-client' },
    'wrong-audience': { ...claims, aud: 'https://elsewhere.test/api/founder-hub' },
    'missing-scope': { ...claims, scope: 'openid founder-hub' },
  }
  const api = auth.api as unknown as {
    getSession: () => Promise<unknown>
    verifyJWT: (input: { body: { token: string } }) => Promise<unknown>
  }
  t.mock.method(api, 'verifyJWT', async ({ body }: { body: { token: string } }) => ({
    payload: tokens[body.token] ?? null,
  }))
  t.mock.method(api, 'getSession', async () => ({
    session: { activeOrganizationId: 'org_hub', createdAt: new Date(), id: 'session_web' },
    user: { email: 'hub@example.test', id: 'user_hub', twoFactorEnabled: false },
  }))
  const role = options.role ?? 'creator'
  const calls: BackendCall[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      body: typeof init?.body === 'string' ? init.body : null,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
    }
    calls.push(call)
    const path = call.url.pathname
    if (path === '/v1/founder-hub/session')
      return options.session?.() ?? Response.json(founderHubSnapshot(role))
    if (path === '/v1/access')
      return Response.json({ deniedPermissions: [], organizationId: 'org_hub', role })
    if (path.startsWith('/v1/entitlements/features/'))
      return Response.json({ allowed: true, currentPlan: 'pro', requiredPlan: 'pro' })
    if (path.startsWith('/v1/voice/') && options.voice) return options.voice(call)
    throw new Error(`unexpected backend call ${call.method} ${path}`)
  })
  const logged: string[] = []
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const)
    t.mock.method(console, method, (...values: unknown[]) => {
      logged.push(
        values.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')
      )
    })
  return {
    calls,
    logged,
    voiceCalls: () => calls.filter((call) => call.url.pathname.startsWith('/v1/voice/')),
  }
}

/** Call a route export the way Next.js does. */
async function callRoute(
  area: 'founder-hub' | 'v1',
  operation: VoiceOperation,
  headers: Record<string, string>
) {
  const module = (await import(`@/app/api/${area}/voice/${operation.file}/route`)) as Record<
    string,
    (
      request: NextRequest,
      context: { params: Promise<Record<string, string>> }
    ) => Promise<Response>
  >
  const request = new NextRequest(`https://shots.test/api/${area}/voice/${operation.suffix}`, {
    method: operation.method,
    headers: { ...headers, ...('body' in operation ? { 'content-type': 'application/json' } : {}) },
    body: 'body' in operation ? JSON.stringify(operation.body) : undefined,
  })
  const response = await module[operation.method](request, {
    params: Promise.resolve<Record<string, string>>(operation.params ?? {}),
  })
  return { status: response.status, text: await response.text() }
}

const gateway = (token = 'good', workspace = workspaceId) => ({
  authorization: `Bearer ${token}`,
  'x-shots-founder-hub-service': serviceToken,
  'x-shots-organization-id': workspace,
})

const answer = (operation: VoiceOperation) =>
  'answer' in operation
    ? Response.json(operation.answer, { status: operation.goStatus ?? 200 })
    : new Response(null, { status: operation.goStatus })

test('each Founder Hub voice route runs the same handler as its /api/v1/voice route', async (t) => {
  const harness = await voiceHarness(t, {
    voice: (call) =>
      answer(
        operations.find(
          (operation) =>
            operation.method === call.method &&
            `/v1/voice/${operation.suffix.split('?')[0]}` === call.url.pathname
        )!
      ),
  })
  assert.equal(operations.length, founderHubContracts.length)
  for (const operation of operations) {
    const name = `${operation.method} ${operation.suffix}`
    const browser = await callRoute('v1', operation, {})
    const hub = await callRoute('founder-hub', operation, gateway())
    const [browserCall, hubCall] = harness.voiceCalls().slice(-2)
    assert.equal(browser.status, operation.goStatus ?? 200, `${name}: ${browser.text}`)
    assert.deepEqual(hub, browser, name)
    assert.equal(hubCall.method, browserCall.method, name)
    assert.equal(hubCall.url.href, browserCall.url.href, name)
    assert.equal(hubCall.body, browserCall.body, name)
    // The phone's workspace id maps to its organization, and Go checks the grant.
    assert.equal(hubCall.headers.get('x-organization-id'), 'org_hub', name)
    assert.equal(hubCall.headers.get('x-principal-client'), 'shots-founder-hub', name)
    assert.equal(hubCall.headers.get('x-user-id'), 'user_hub', name)
    assert.equal(hubCall.headers.get('x-session-id'), 'session_hub', name)
    assert.equal(browserCall.headers.get('x-principal-client'), null, name)
  }
  // Route logs carry ids and statuses only, never a request or response body.
  assert.ok(harness.logged.length >= operations.length * 2)
  assert.deepEqual(
    harness.logged.filter((line) => line.includes('PRIVATE')),
    []
  )
})

test('Founder Hub voice routes authenticate the gateway, the token and the workspace', async (t) => {
  let session = () => Response.json(founderHubSnapshot('creator'))
  const harness = await voiceHarness(t, {
    session: () => session(),
    voice: () => Response.json(voiceSettings),
  })
  const [settings, create] = operations
  const cases: [string, Record<string, string>, number][] = [
    ['no gateway', { authorization: 'Bearer good', 'x-shots-organization-id': workspaceId }, 403],
    ['a wrong gateway token', { ...gateway(), 'x-shots-founder-hub-service': 'x'.repeat(48) }, 403],
    [
      'no access token',
      { 'x-shots-founder-hub-service': serviceToken, 'x-shots-organization-id': workspaceId },
      401,
    ],
    ['an invalid access token', gateway('invalid'), 401],
    ['another client', gateway('wrong-azp'), 401],
    ['another audience', gateway('wrong-audience'), 401],
    ['missing scopes', gateway('missing-scope'), 401],
    [
      'no workspace',
      { authorization: 'Bearer good', 'x-shots-founder-hub-service': serviceToken },
      400,
    ],
    ['an organization id instead of the workspace id', gateway('good', 'org_hub'), 400],
    ["another person's workspace", gateway('good', otherWorkspaceId), 404],
  ]
  for (const operation of [settings, create])
    for (const [name, headers, status] of cases)
      assert.equal(
        (await callRoute('founder-hub', operation, headers)).status,
        status,
        `${operation.method} ${operation.suffix}: ${name}`
      )
  session = () => Response.json({ error: 'unauthorized' }, { status: 401 })
  assert.equal((await callRoute('founder-hub', settings, gateway())).status, 401, 'revoked grant')
  assert.deepEqual(harness.voiceCalls(), [], 'a refused request never reaches the voice API')
  assert.deepEqual(
    harness.logged.filter((line) => line.includes('PRIVATE')),
    []
  )
})

test('a Founder Hub member gets the answers a browser member gets', async (t) => {
  let voice = (_call: BackendCall) => Response.json({ error: 'not found' }, { status: 404 })
  const harness = await voiceHarness(t, { role: 'viewer', voice: (call) => voice(call) })
  const get = operations.find(
    (operation) => operation.method === 'GET' && operation.file === 'notes/[id]'
  )!
  const index = operations.find((operation) => operation.suffix === 'notes/index')!
  const draft = operations.find((operation) => operation.suffix.endsWith('/draft'))!
  // Another member's note is not found, so its existence does not leak.
  const browserNote = await callRoute('v1', get, {})
  assert.equal(browserNote.status, 404)
  assert.deepEqual(await callRoute('founder-hub', get, gateway()), browserNote)
  // The backend's membership refusal reaches the phone unchanged.
  voice = () => Response.json({ error: 'forbidden' }, { status: 403 })
  const browserIndex = await callRoute('v1', index, {})
  assert.equal(browserIndex.status, 403)
  assert.deepEqual(await callRoute('founder-hub', index, gateway()), browserIndex)
  // A viewer cannot make a draft on either path, before the voice API is called.
  const calls = harness.voiceCalls().length
  const browserDraft = await callRoute('v1', draft, {})
  assert.equal(browserDraft.status, 403)
  assert.deepEqual(await callRoute('founder-hub', draft, gateway()), browserDraft)
  assert.equal(harness.voiceCalls().length, calls)
})

test('changing the workspace switches is not served to Founder Hub', async () => {
  const { PUT } = await import('@/app/api/[...unmatched]/route')
  const path = '/api/founder-hub/voice/settings/workspace'
  assert.ok(!existsSync(join(process.cwd(), `app${path}/route.ts`)))
  const response = await PUT(new NextRequest(`https://shots.test${path}`, { method: 'PUT' }))
  assert.equal(response.status, 404)
})

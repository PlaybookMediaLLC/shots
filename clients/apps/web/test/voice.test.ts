import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'
import { type RouteContract, routeContractSchema } from '@/lib/api/contract'
import { contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { contentDraftSettingsSchema } from '@/lib/api/contracts/content-draft-platform'
import * as voiceNotes from '@/lib/api/contracts/voice'
import * as voiceActions from '@/lib/api/contracts/voice-actions'
import * as voice from '@/lib/api/contracts/voice-schemas'
import { openApiSpec } from '@/lib/api/openapi'
import { createLinks, CREATE_LINKS, platformArea, VOICE_NOTES } from '@/lib/platform/navigation'
import { recordedLabel, reviewParts } from '@/lib/voice/client'

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

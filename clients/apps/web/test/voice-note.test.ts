import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { jsx } from 'react/jsx-runtime'
import type { Root } from 'react-dom/client'

// The inbox and a note render in jsdom against a stubbed voice API.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const globals = Object.getOwnPropertyDescriptors(globalThis)
const browser = {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ...Object.fromEntries(
    [
      'CustomEvent',
      'DocumentFragment',
      'Element',
      'Event',
      'FocusEvent',
      'HTMLElement',
      'HTMLFormElement',
      'KeyboardEvent',
      'MouseEvent',
      'MutationObserver',
      'Node',
    ].map((name) => [name, dom.window[name]])
  ),
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  fetch: backend,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const names = Object.keys(browser)
// React DOM and Radix detect the browser when they load, so they load after the globals exist.
let ui: {
  createRoot: typeof import('react-dom/client').createRoot
  VoiceInbox: typeof import('@/components/voice/VoiceInbox').VoiceInbox
}
before(async () => {
  for (const [name, value] of Object.entries(browser)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const [{ createRoot }, { VoiceInbox }] = await Promise.all([
    import('react-dom/client'),
    import('@/components/voice/VoiceInbox'),
  ])
  ui = { createRoot, VoiceInbox }
})
after(() => {
  dom.window.close()
  for (const name of names) {
    if (globals[name]) Object.defineProperty(globalThis, name, globals[name])
    else Reflect.deleteProperty(globalThis, name)
  }
})

const noteId = 'cnote000000000000000000001'
const at = '2026-11-11T09:00:00Z'
const settings = {
  canManage: false,
  limits: {
    maxCommandChars: 2_000,
    maxNoteMs: 1_800_000,
    maxTranscriptChars: 100_000,
    minNoteMs: 1_000,
    warnAtMs: 1_500_000,
  },
  member: { remoteTextConsentAt: null, voiceCommands: false },
  minAppVersion: '1.0.0',
  switches: { audioUpload: true, confirm: true, drafts: true, notes: true, parse: true },
  workspace: { audioUpload: true, draftGeneration: false, voiceCommands: false, voiceNotes: true },
}
const note = {
  id: noteId,
  clientNoteId: 'client-note-1',
  title: 'Launch idea',
  projectId: null,
  recordedAt: at,
  recordedTimeZone: 'UTC',
  receivedAt: at,
  locale: 'en-US',
  durationMs: 61_000,
  audioUploadConsent: true,
  revision: 1,
  deleted: false,
  deletedAt: null,
  currentTranscriptRevisionId: 'crev0000000000000000000001',
  transcriptConflict: false,
  createdAt: at,
  updatedAt: at,
}
const revision = (id: string, text: string, origin: string) => ({
  id,
  clientRevisionId: id,
  parentId: null,
  origin,
  locale: null,
  engine: null,
  text,
  segments: [],
  redacted: false,
  createdByUserId: 'user_1',
  createdAt: at,
})

/** The backend's state, and every request the browser sent. */
let detail = {
  ...note,
  transcripts: [revision('crev0000000000000000000001', 'First words', 'remote')],
  runs: [] as unknown[],
  command: null,
}
/** Transcript saves that fail as if the network dropped them. */
let dropSaves = 0
const requests: { method: string; path: string; body: unknown }[] = []

const reply = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input)
  const method = init?.method ?? 'GET'
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  requests.push({ method, path, body })
  if (path === '/api/v1/voice/settings') return reply(settings)
  if (path === '/api/v1/voice/notes') {
    return reply({ nextCursor: null, notes: [{ ...note, excerpt: 'First words' }] })
  }
  if (path === `/api/v1/voice/notes/${noteId}` && method === 'GET') return reply(detail)
  if (path === `/api/v1/voice/notes/${noteId}/transcripts` && method === 'POST') {
    if (dropSaves > 0) {
      dropSaves--
      throw new TypeError('Failed to fetch')
    }
    const input = body as { clientRevisionId: string; text: string }
    const saved = revision('crev0000000000000000000002', input.text, 'user_edit')
    detail = {
      ...detail,
      currentTranscriptRevisionId: saved.id,
      transcripts: [...detail.transcripts, saved],
    }
    return reply({ command: null, note: detail, revision: saved }, 201)
  }
  if (path === `/api/v1/voice/notes/${noteId}/audio` && method === 'DELETE') {
    detail = { ...detail, runs: [] }
    return reply(null, 204)
  }
  return reply({ error: 'not found' }, 404)
}

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  requests.length = 0
})

async function settle() {
  for (let i = 0; i < 5; i++) await act(() => new Promise((done) => setTimeout(done, 0)))
}

async function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = document.createElement('div')
  document.body.append(container)
  root = ui.createRoot(container)
  await act(async () =>
    root?.render(
      jsx(QueryClientProvider, {
        client: queryClient,
        children: jsx(ui.VoiceInbox, { canDraft: true }),
      })
    )
  )
  await settle()
}

async function click(name: string) {
  const button = [...document.querySelectorAll('button')].findLast(
    (item) => item.textContent?.trim() === name
  )
  assert.ok(button, `missing button ${name}`)
  await act(async () => button.click())
  await settle()
}

async function type(value: string) {
  const field = document.querySelector('textarea')
  assert.ok(field, 'missing the transcript editor')
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(
    field,
    value
  )
  await act(async () => field.dispatchEvent(new dom.window.Event('input', { bubbles: true })))
}

/** Open the note from the inbox list. */
async function open() {
  const button = document.querySelector('nav[aria-label="Voice notes"] button')
  assert.ok(button, 'missing the inbox note')
  await act(async () => (button as HTMLButtonElement).click())
  await settle()
}

const sent = (method: string, suffix: string) =>
  requests.filter((item) => item.method === method && item.path.endsWith(suffix))
const text = () => document.body.textContent ?? ''

test('an edit keeps its id across retries of the same text, and newer text gets a new one', async () => {
  detail = {
    ...note,
    transcripts: [revision('crev0000000000000000000001', 'First words', 'remote')],
    runs: [],
    command: null,
  }
  await mount()
  await open()
  // A remote revision came from the phone's chosen provider, not from Shots.
  assert.match(text(), /Transcribed by a cloud provider/)

  await click('Edit')
  await type('Second words')
  dropSaves = 2
  await click('Save as a new revision')
  await click('Save as a new revision')
  await type('Third words')
  await click('Save as a new revision')

  const saves = sent('POST', '/transcripts').map(
    (item) => item.body as { clientRevisionId: string; text: string }
  )
  assert.deepEqual(
    saves.map((save) => save.text),
    ['Second words', 'Second words', 'Third words']
  )
  // The retry may have reached the server, so it is the same request; the newer text is not.
  assert.equal(saves[0]?.clientRevisionId, saves[1]?.clientRevisionId)
  assert.notEqual(saves[2]?.clientRevisionId, saves[0]?.clientRevisionId)

  // The inbox shows the new excerpt without refetching its pages.
  assert.equal(sent('GET', '/api/v1/voice/notes').length, 1)
  const inbox = document.querySelector('nav[aria-label="Voice notes"]')
  assert.match(inbox?.textContent ?? '', /Third words/)
  assert.doesNotMatch(inbox?.textContent ?? '', /First words/)
})

test('deleting the audio asks first, then reloads the note and no inbox page', async () => {
  detail = {
    ...note,
    transcripts: [revision('crev0000000000000000000001', 'First words', 'on_device')],
    runs: [
      {
        runIndex: 0,
        startOffsetMs: 0,
        durationMs: 61_000,
        sampleRateHz: 16_000,
        contentType: 'audio/wav',
        bytes: 44,
        sha256: 'a'.repeat(64),
        status: 'available',
      },
    ],
    command: null,
  }
  await mount()
  await open()
  await click('Delete audio')
  assert.equal(sent('DELETE', '/audio').length, 0, 'the dialog asks before deleting')
  await click('Delete audio')

  assert.equal(sent('DELETE', '/audio').length, 1)
  assert.equal(sent('GET', `/api/v1/voice/notes/${noteId}`).length, 2)
  assert.equal(sent('GET', '/api/v1/voice/notes').length, 1)
  assert.match(text(), /Only the transcript was synced\./)
})

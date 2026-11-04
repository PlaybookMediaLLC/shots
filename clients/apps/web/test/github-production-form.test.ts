import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import { act } from 'react'
import { jsx } from 'react/jsx-runtime'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, httpLink } from '@trpc/client'
import superjson from 'superjson'
import type { GitHubProductionPolicy } from 'screenshot-studio-backend-sdk'
import type { AppRouter } from '@/lib/trpc/router'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
// jsdom lays nothing out; Radix Select scrolls its chosen option into view.
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
const globals = Object.getOwnPropertyDescriptors(globalThis)
const browser = {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  // Radix Select checks whether it sits in a form and portals its menu; Collapsible measures on the next frame.
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
  GitHubProduction: typeof import('@/components/workflows/GitHubProduction').GitHubProduction
  TRPCProvider: typeof import('@/lib/trpc/react').TRPCProvider
}
before(async () => {
  for (const [name, value] of Object.entries(browser)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const [{ createRoot }, { GitHubProduction }, { TRPCProvider }] = await Promise.all([
    import('react-dom/client'),
    import('@/components/workflows/GitHubProduction'),
    import('@/lib/trpc/react'),
  ])
  ui = { createRoot, GitHubProduction, TRPCProvider }
})
after(() => {
  dom.window.close()
  for (const name of names) {
    if (globals[name]) Object.defineProperty(globalThis, name, globals[name])
    else Reflect.deleteProperty(globalThis, name)
  }
})

const savedPolicy: GitHubProductionPolicy = {
  schemaVersion: 1,
  enabled: false,
  installationId: 7,
  repositoryId: '42',
  environments: ['production'],
  refs: ['refs/heads/main'],
  signal: 'deployment_status',
  workflows: [{ id: 301, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }],
  jobNames: ['deploy'],
  trustedAppIds: [900],
  requireChangeReceipt: true,
  trustActionsOutcome: false,
  definitionId: 'definition',
}

/** The backend's policy history: a save is refused unless it names the latest revision. */
let revisions: GitHubProductionPolicy[] = []
const requests: { method: string; url: string; body: unknown }[] = []

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const version = (index: number) => ({
  id: `policy-${index + 1}`,
  revision: index + 1,
  policy: revisions[index],
  createdAt: '2026-10-01T00:00:00Z',
})

async function backend(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  if (url.startsWith('http://localhost/api/trpc')) return reply({}, 404)
  requests.push({ method, url, body })
  const path = url.split('?')[0]
  if (path.endsWith('/production-catalog')) {
    return reply({
      access: 'ok',
      reason: '',
      installationId: 7,
      repositoryId: '42',
      capabilities: null,
      workflows: [savedPolicy.workflows[0]],
      jobs: [],
    })
  }
  if (path.endsWith('/delivery-recovery')) {
    return reply({
      status: 'ok',
      reason: '',
      gap: false,
      hasMore: false,
      windowStart: null,
      lastCompleteAt: null,
      nextAttemptAt: null,
      deliveries: [],
    })
  }
  if (path.endsWith('/production-preview')) {
    return reply({ status: 'matched', reason: 'Matched.', strength: '', checks: [] })
  }
  if (path.endsWith('/production') && method === 'PUT') {
    const save = body as { expectedRevision: number; policy: GitHubProductionPolicy }
    if (save.expectedRevision !== revisions.length) {
      return reply({ error: 'publishing resource already exists' }, 409)
    }
    revisions = [...revisions, save.policy]
    return reply(version(revisions.length - 1))
  }
  if (path.endsWith('/production')) {
    return reply({
      policies: revisions.map((_, index) => version(index)).reverse(),
      observations: [observation],
      nextCursor: '',
    })
  }
  return reply({ error: 'not found' }, 404)
}

const observation = {
  id: 'observation',
  deliveryId: 'delivery',
  evidence: {
    schemaVersion: 1,
    eventName: 'deployment_status',
    action: 'created',
    key: 'key',
    objectKey: 'object',
    objectId: '1',
    observationId: '2',
    installationId: 7,
    repositoryId: '42',
    repositoryName: 'fixture/product',
    occurredAt: '2026-10-01T00:00:00Z',
    state: 'success',
    environment: 'production',
    deploymentEnvironment: 'production',
    production: true,
    ref: 'refs/heads/main',
    sha: 'abc',
    url: '',
    appId: 900,
    workflow: savedPolicy.workflows[0],
    runId: 1,
    runAttempt: 1,
    jobId: 1,
    jobName: 'deploy',
    association: '',
    conflict: false,
    changeReceipt: null,
    receiptRevision: '',
    receiptAppId: 0,
  },
  policyId: null,
  workflowVersionId: null,
  eventId: null,
  status: 'matched',
  origin: 'live',
  decision: { status: 'matched', reason: 'Matched.', strength: '', checks: [] },
  duplicates: 0,
  receivedAt: '2026-10-01T00:00:00Z',
  processedAt: null,
  runId: null,
  dispatchStatus: 'none',
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
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpLink({ url: 'http://localhost/api/trpc', transformer: superjson, fetch: backend })],
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = ui.createRoot(container)
  await act(async () =>
    root?.render(
      jsx(QueryClientProvider, {
        client: queryClient,
        children: jsx(ui.TRPCProvider, {
          trpcClient,
          queryClient,
          children: jsx(ui.GitHubProduction, { sourceId: 'source', canManage: true }),
        }),
      })
    )
  )
  await settle()
}

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector)
  assert.ok(found, `missing ${selector}`)
  return found
}

async function type(selector: string, value: string) {
  const field = element<HTMLTextAreaElement | HTMLSelectElement>(selector)
  const prototype = Object.getPrototypeOf(field) as object
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value)
  const event = field.tagName === 'SELECT' ? 'change' : 'input'
  await act(async () => field.dispatchEvent(new dom.window.Event(event, { bubbles: true })))
}

/** Pick a Select option with the keyboard, as jsdom has no pointer: open, then Enter on the option. */
async function choose(selector: string, name: RegExp) {
  const key = (target: Element) =>
    act(async () => {
      ;(target as HTMLElement).focus()
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    })
  await key(element(selector))
  await settle()
  const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
    name.test(item.textContent ?? '')
  )
  assert.ok(option, `missing option ${name}`)
  await key(option)
  await settle()
}

async function click(name: string) {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent === name)
  assert.ok(button, `missing button ${name}`)
  await act(async () => button.click())
  await settle()
}

const sent = (method: string, path: string) =>
  requests.filter((item) => item.method === method && item.url.endsWith(path))
const text = () => document.body.textContent ?? ''

test('a concurrent policy save is refused as a conflict and the editor can reload it', async () => {
  revisions = [savedPolicy]
  await mount()
  await type('#production-environments', 'production\nlive')
  // Another administrator saves revision 2; the background refetch must not rebase the draft.
  revisions = [...revisions, { ...savedPolicy, refs: ['refs/heads/release'] }]
  await click('Refresh events')
  await click('Save policy revision')

  assert.equal(revisions.length, 2, 'the other administrator’s revision was overwritten')
  const [put] = sent('PUT', '/production')
  assert.deepEqual(put?.body, {
    expectedRevision: 1,
    policy: { ...savedPolicy, environments: ['production', 'live'] },
  })
  assert.match(text(), /publishing resource already exists/)
  assert.match(text(), /changed to revision 2 after you started editing revision 1\./)

  await click('Reload latest revision')
  assert.equal(element<HTMLTextAreaElement>('#production-refs').value, 'refs/heads/release')
  assert.equal(element<HTMLTextAreaElement>('#production-environments').value, 'production')
  await click('Save policy revision')
  assert.deepEqual(revisions, [savedPolicy, revisions[1], revisions[1]])
  assert.match(text(), /Policy revision saved/)
})

test('a save refused before the newer revision was fetched offers the reload', async () => {
  revisions = [savedPolicy]
  await mount()
  await type('#production-environments', 'live')
  revisions = [...revisions, savedPolicy]
  await click('Save policy revision')

  assert.equal(revisions.length, 2)
  assert.match(text(), /publishing resource already exists/)
  assert.match(text(), /changed to revision 2 after you started editing revision 1\./)
  assert.ok(
    [...document.querySelectorAll('button')].some((b) => b.textContent === 'Reload latest revision')
  )
})

test('preview and save submit the same normalized policy', async () => {
  revisions = [savedPolicy]
  await mount()
  await choose('#production-observation', /^deployment_status · 1 · /)
  await type('#production-environments', ' production \n')
  await type('#production-refs', '')
  await type('#production-jobs', 'deploy\n\n')
  await click('Preview current policy')
  await click('Save policy revision')

  const normalized = { ...savedPolicy, refs: [] }
  const [preview] = sent('POST', '/production-preview')
  assert.deepEqual(preview?.body, { policy: normalized, observationId: 'observation' })
  const [save] = sent('PUT', '/production')
  assert.deepEqual(save?.body, { expectedRevision: 1, policy: normalized })
  assert.match(text(), /matched — Matched\./)
})

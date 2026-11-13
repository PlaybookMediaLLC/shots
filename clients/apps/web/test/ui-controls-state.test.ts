import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import { act, createElement, useLayoutEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import type { Root } from 'react-dom/client'
import type { SaveResult } from '@/components/settings/PreferencesProvider'

// The existing editor test environment supplies jsdom; load DOM-aware modules after globals.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const originals = Object.getOwnPropertyDescriptors(globalThis)
const browser = {
  window: dom.window,
  location: dom.window.location,
  document: dom.window.document,
  navigator: dom.window.navigator,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ...Object.fromEntries(
    [
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLFormElement',
      'Event',
      'FocusEvent',
      'KeyboardEvent',
      'MouseEvent',
      'MutationObserver',
      'Node',
      'NodeFilter',
      'CustomEvent',
      'DocumentFragment',
    ].map((name) => [name, dom.window[name]])
  ),
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  IS_REACT_ACT_ENVIRONMENT: true,
}
let ui: {
  createRoot: typeof import('react-dom/client').createRoot
  TimePicker: typeof import('@/components/ui/time-picker').TimePicker
  ColorPanel: typeof import('@/components/ui/color-picker').ColorPanel
  ColorField: typeof import('@/components/editor/inspector/fields').ColorField
  useSaveState: typeof import('@/components/settings/controls').useSaveState
}
let root: Root | null = null
before(async () => {
  for (const [name, value] of Object.entries(browser))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  const [reactDom, time, color, fields, controls] = await Promise.all([
    import('react-dom/client'),
    import('@/components/ui/time-picker'),
    import('@/components/ui/color-picker'),
    import('@/components/editor/inspector/fields'),
    import('@/components/settings/controls'),
  ])
  ui = {
    createRoot: reactDom.createRoot,
    TimePicker: time.TimePicker,
    ColorPanel: color.ColorPanel,
    ColorField: fields.ColorField,
    useSaveState: controls.useSaveState,
  }
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
})
after(() => {
  dom.window.close()
  for (const name of Object.keys(browser)) {
    if (originals[name]) Object.defineProperty(globalThis, name, originals[name])
    else Reflect.deleteProperty(globalThis, name)
  }
})
async function mount(element: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  root = ui.createRoot(container)
  await act(async () => root!.render(element))
}
function get<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  assert.ok(element, selector)
  return element
}
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      text
    )
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
async function key(element: Element, key: string, shiftKey = false) {
  await act(async () =>
    element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('invalid time text blocks native submission and reports invalidity to actions, then recovers', async () => {
  let valid = true
  let submitted: string | null = null
  const onValidityChange = (next: boolean) => {
    valid = next
  }
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitted = String(new dom.window.FormData(event.currentTarget).get('time'))
  }
  function Form() {
    const [value, setValue] = useState('09:00')
    return createElement(
      'form',
      { onSubmit },
      createElement(ui.TimePicker, {
        value,
        onChange: setValue,
        onValidityChange,
        name: 'time',
        'aria-label': 'Publish time',
      })
    )
  }
  await mount(createElement(Form))
  const input = get<HTMLInputElement>('input:not([type=hidden])')
  const form = get<HTMLFormElement>('form')
  await type(input, 'nonsense')
  await act(async () =>
    input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
  )
  assert.equal(valid, false)
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  await act(async () => form.requestSubmit())
  assert.equal(submitted, null)
  assert.equal(new dom.window.FormData(form).get('time'), null)
  await type(input, '10:30')
  await act(async () => form.requestSubmit())
  assert.equal(valid, true)
  assert.equal(submitted, '10:30')
  await type(input, '')
  await act(async () => form.requestSubmit())
  assert.equal(submitted, '')
})

test('a required empty time stays visible and invalid instead of restoring its previous value', async () => {
  await mount(createElement(ui.TimePicker, { value: '09:00', onChange: () => {}, required: true }))
  const input = get<HTMLInputElement>('input')
  await type(input, '')
  await act(async () =>
    input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
  )
  assert.equal(input.value, '')
  await act(async () => {
    assert.equal(input.checkValidity(), false)
  })
})

for (const initial of ['#ffffff', '#808080', '#000000']) {
  test(`hue intent survives ${initial} until saturation and brightness are increased`, async () => {
    function Color() {
      const [color, setColor] = useState(initial)
      return createElement(ui.ColorPanel, {
        color,
        onChange: setColor,
      })
    }
    await mount(createElement(Color))
    const hue = get('[aria-label="Hue"]')
    for (let i = 0; i < 12; i++) await key(hue, 'ArrowRight', true)
    assert.equal(hue.getAttribute('aria-valuenow'), '120')
    const area = get('[aria-label="Saturation and brightness"]')
    for (let i = 0; i < 10; i++) await key(area, 'ArrowRight', true)
    for (let i = 0; i < 10; i++) await key(area, 'ArrowUp', true)
    assert.equal(get<HTMLInputElement>('[aria-label="Hex color"]').value, '#00ff00')
  })
}

for (const [color, expected] of [
  ['#fff', '#ffffff'],
  ['#f008', '#ff000088'],
  ['rgb(255, 0, 0)', '#ff0000'],
  ['rgba(100%, 0%, 0%, 50%)', '#ff000080'],
  ['#ff000080', '#ff000080'],
]) {
  test(`the color panel reads ${color}`, async () => {
    await mount(createElement(ui.ColorPanel, { color, onChange: () => {} }))
    assert.equal(get<HTMLInputElement>('[aria-label="Hex color"]').value, expected)
  })
}
for (const alpha of [0, 0.5, 1]) {
  test(`opacity ${alpha} uses a fully opaque gradient endpoint`, async () => {
    await mount(
      createElement(ui.ColorPanel, { color: `rgba(255, 0, 0, ${alpha})`, onChange: () => {} })
    )
    const opacity = get<HTMLElement>('[aria-label="Opacity"]')
    assert.equal(opacity.getAttribute('aria-valuenow'), String(alpha * 100))
    assert.match(opacity.style.background, /rgb\(255, 0, 0\)|#ff0000/)
    assert.doesNotMatch(opacity.style.background, /#ff000080|#ff000000/)
  })
}

test('unparsed color input is identified and inspector triggers include the property', async () => {
  await mount(
    createElement(
      'div',
      null,
      createElement(ui.ColorPanel, { color: 'unreadable', onChange: () => {} }),
      createElement(ui.ColorField, { label: 'Fill', value: '#ffffff', onChange: () => {} }),
      createElement(ui.ColorField, { label: 'Border', value: '#ffffff', onChange: () => {} })
    )
  )
  assert.match(get('[role="alert"]').textContent ?? '', /could not be read/)
  assert.ok(document.querySelector('button[aria-label="Fill: #ffffff"]'))
  assert.ok(document.querySelector('button[aria-label="Border: #ffffff"]'))
})

for (const reverse of [false, true]) {
  for (const fail of [false, true]) {
    test(`save feedback waits for the full batch (reverse=${reverse}, failure=${fail})`, async () => {
      let state!: ReturnType<typeof ui.useSaveState>
      function Saves() {
        const current = ui.useSaveState()
        useLayoutEffect(() => {
          state = current
        })
        return null
      }
      await mount(createElement(Saves))
      const first = deferred<SaveResult>(),
        second = deferred<SaveResult>()
      let jobs!: Promise<boolean>[]
      await act(async () => {
        jobs = [state[1](() => first.promise), state[1](() => second.promise)]
      })
      await act(async () =>
        (reverse ? second : first).resolve(
          fail ? { ok: false, error: 'Save unavailable' } : { ok: true }
        )
      )
      assert.equal(state[0], 'saving')
      await act(async () => {
        ;(reverse ? first : second).resolve({ ok: true })
        await Promise.all(jobs)
      })
      assert.equal(state[0], fail ? 'error' : 'saved')
    })
  }
}

// Hook regressions use the real tRPC client against controlled transport replies;
// authenticated and persisted effects are covered separately by the browser suite.
async function onboardingHarness(
  onAdvance?: (
    run: import('@/lib/tenant/onboarding-runs').StoredOnboardingRun,
    signal: AbortSignal
  ) => Promise<void>,
  terminal = false
) {
  const [
    { createTRPCClient, httpLink },
    { default: superjson },
    { TRPCProvider },
    { useOnboardingRun },
  ] = await Promise.all([
    import('@trpc/client'),
    import('superjson'),
    import('@/lib/trpc/react'),
    import('@/components/onboarding/run-progress'),
  ])
  const initial: import('@/lib/tenant/onboarding-runs').StoredOnboardingRun = {
    id: 'run-a',
    status: 'running',
    progress: 10,
    completedStages: [],
    stage: 'fast_path',
    completedAt: null,
    createdByUserId: null,
    deadlineAt: new Date(),
    discoveredUrls: [],
    enrichmentCostMicros: 0,
    errorCode: null,
    errorMessage: null,
    fastPathMs: 0,
    modelCostMicros: 0,
    pageLimit: 10,
    pagesDiscovered: 10,
    pagesProcessed: 1,
    pagesSkipped: 0,
    startedAt: new Date(),
    tokenBudget: 100,
    tokensUsed: 0,
    updatedAt: new Date(),
    url: 'https://example.com',
    workflowId: 'workflow',
  }
  let calls = 0
  let state!: ReturnType<typeof useOnboardingRun>
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
  const client = createTRPCClient<import('@/lib/trpc/router').AppRouter>({
    links: [
      httpLink({
        url: 'http://localhost/api/trpc',
        transformer: superjson,
        fetch: async () => {
          calls++
          return new Response(
            JSON.stringify({
              result: {
                data: superjson.serialize({
                  run: { ...initial, progress: 20, status: terminal ? 'completed' : 'running' },
                }),
              },
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        },
      }),
    ],
  })
  function Poll() {
    const current = useOnboardingRun(initial, onAdvance)
    useLayoutEffect(() => {
      state = current
    })
    return null
  }
  await mount(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      jsx(TRPCProvider, { trpcClient: client, queryClient, children: createElement(Poll) })
    )
  )
  return {
    initial,
    get state() {
      return state
    },
    get calls() {
      return calls
    },
  }
}
for (const terminal of [false, true]) {
  test(`onboarding retries unconsumed refreshes and stops after five failures (terminal=${terminal})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let refreshes = 0
    let fail = true
    const hook = await onboardingHarness(async () => {
      refreshes++
      if (fail) throw new Error('Profile unavailable')
    }, terminal)
    for (let i = 0; i < 5; i++) await act(async () => t.mock.timers.tick(6_000))
    assert.equal(refreshes, 5)
    assert.equal(hook.state.lost, true)
    assert.equal(hook.state.run.progress, 10)
    await act(async () => t.mock.timers.tick(30_000))
    assert.equal(refreshes, 5)
    fail = false
    await act(async () => hook.state.retry())
    assert.equal(hook.state.lost, false)
    await act(async () => t.mock.timers.tick(6_000))
    assert.equal(hook.state.run.progress, 20)
    assert.equal(refreshes, 6)
  })
}

test('a pending old onboarding refresh cannot replace cancellation or a new run', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const refresh = deferred<void>()
  let signal: AbortSignal | undefined
  const hook = await onboardingHarness(async (_run, active) => {
    signal = active
    await refresh.promise
  })
  await act(async () => t.mock.timers.tick(1_000))
  assert.ok(signal)
  await act(async () =>
    hook.state.setRun({ ...hook.initial, id: 'run-b', status: 'cancelled', progress: 0 })
  )
  assert.equal(signal.aborted, true)
  await act(async () => refresh.resolve())
  assert.equal(hook.state.run.id, 'run-b')
  assert.equal(hook.state.run.status, 'cancelled')
  await act(async () => t.mock.timers.tick(30_000))
  assert.equal(hook.calls, 1)
})

test('queued preferences retain later intent when the first save fails', async (t) => {
  const { PreferencesProvider, usePreferences } =
    await import('@/components/settings/PreferencesProvider')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const initial: import('@/components/settings/PreferencesProvider').Preferences = {
    accentColor: '#123456',
    developerMode: false,
    dismissedTips: [],
    emailNotifications: true,
    experiments: {},
    navigation: 'expanded',
    showScrollbars: false,
    textDirection: 'ltr',
    theme: 'system',
    timeFormat: 'auto',
    timeZone: null,
    updatedAt: null,
    version: 1,
    weekStart: 'monday',
  }
  queryClient.setQueryData(['me', 'preferences'], initial)
  const first = deferred<Response>(),
    second = deferred<Response>()
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => (++calls === 1 ? first.promise : second.promise))
  let state!: ReturnType<typeof usePreferences>
  function Read() {
    const current = usePreferences()
    useLayoutEffect(() => {
      state = current
    })
    return null
  }
  await mount(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(PreferencesProvider, null, createElement(Read))
    )
  )
  let a!: Promise<SaveResult>, b!: Promise<SaveResult>
  await act(async () => {
    a = state.save({ navigation: 'compact' })
    b = state.save({ timeFormat: '24h' })
  })
  assert.equal(calls, 1, 'preferences writes are serialized')
  assert.equal(state.preferences?.timeFormat, '24h')
  await act(async () => {
    first.reject(new Error('Unavailable'))
    await a
  })
  assert.equal(calls, 2)
  assert.equal(state.preferences?.navigation, 'expanded')
  assert.equal(state.preferences?.timeFormat, '24h')
  await act(async () => {
    second.resolve(
      new Response(JSON.stringify({ ...initial, timeFormat: '24h', version: 2 }), {
        headers: { 'content-type': 'application/json' },
      })
    )
    await b
  })
  assert.equal(state.preferences?.timeFormat, '24h')
  assert.equal(state.preferences?.navigation, 'expanded')
  assert.equal(
    queryClient.getQueryData<import('@/components/settings/PreferencesProvider').Preferences>([
      'me',
      'preferences',
    ])?.timeFormat,
    '24h'
  )
  queryClient.clear()
})

test('an externally replaced time clears an invalid draft while local typing remains intact', async () => {
  const { TimePicker } = ui
  const onChange = () => {}
  await mount(createElement(TimePicker, { value: '09:00', onChange, required: true }))
  const input = get<HTMLInputElement>('input:not([type=hidden])')
  await type(input, 'invalid')
  await act(async () => {
    assert.equal(input.checkValidity(), false)
  })
  await act(async () =>
    root!.render(createElement(TimePicker, { value: '11:15', onChange, required: true }))
  )
  assert.equal(input.checkValidity(), true)
  assert.match(input.value, /11:15/)
})

test('section anchor navigation keeps the unsaved editor unload guard armed', async () => {
  const { guardWorkflowNavigation } = await import('@/lib/workflows/navigation-guard')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'HTMLAnchorElement')
  Object.defineProperty(globalThis, 'HTMLAnchorElement', {
    configurable: true,
    value: dom.window.HTMLAnchorElement,
  })
  const navigation = new dom.window.EventTarget()
  Object.defineProperty(window, 'navigation', { configurable: true, value: navigation })
  let prompts = 0
  const cleanup = guardWorkflowNavigation((leave) => {
    prompts++
    leave()
  })
  try {
    const anchor = document.createElement('a')
    anchor.href = '#spec-limitations'
    document.body.append(anchor)
    anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.equal(prompts, 0)
    const unload = new dom.window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    assert.equal(unload.defaultPrevented, true)
  } finally {
    cleanup()
    Reflect.deleteProperty(window, 'navigation')
    if (previous) Object.defineProperty(globalThis, 'HTMLAnchorElement', previous)
    else Reflect.deleteProperty(globalThis, 'HTMLAnchorElement')
  }
})

test('an onboarding field preserves focus and draft through refresh, with explicit save and cancel', async () => {
  const { ReviewField } = await import('@/components/onboarding/OnboardingReview')
  let saved: string | undefined
  const props = {
    entry: undefined,
    label: 'Product name',
    onAccept: async () => {},
    onSave: async (text: string) => {
      saved = text
    },
  }
  await mount(createElement(ReviewField, { ...props, value: 'Original name' }))
  await act(async () => get<HTMLButtonElement>('[aria-label="Edit product name"]').click())
  const input = get<HTMLTextAreaElement>('textarea')
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      input,
      'My draft'
    )
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () =>
    root!.render(createElement(ReviewField, { ...props, value: 'Background name' }))
  )
  assert.equal(document.activeElement, input)
  assert.equal(input.value, 'My draft')
  assert.match(get('[role=status]').textContent!, /updated in the background/)
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Save product name')!
      .click()
  )
  assert.equal(saved, 'My draft')
  await act(async () => get<HTMLButtonElement>('[aria-label="Edit product name"]').click())
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click()
  )
  assert.equal(document.querySelector('textarea'), null)
  assert.match(document.body.textContent!, /Background name/)
})

async function queueHarness(t: import('node:test').TestContext) {
  const { useToolQueue } = await import('@/components/tools/useToolQueue')
  const { ImageToolsWorkerClient } = await import('@/lib/image-tools/worker-client')
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async () => ({ width: 10, height: 10, close() {} }),
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'createImageBitmap', previous)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  })
  let queue!: ReturnType<typeof useToolQueue>
  function Harness() {
    const value = useToolQueue('compress')
    useLayoutEffect(() => {
      queue = value
    })
    return null
  }
  await mount(createElement(Harness))
  return {
    get queue() {
      return queue
    },
    Worker: ImageToolsWorkerClient,
  }
}
const imagePlan = () => ({
  options: { encode: { format: 'png' as const, quality: 1, background: '#ffffff' } },
  outputName: 'output.png',
})

test('unmount aborts its image worker and never starts the next queued file', async (t) => {
  const hook = await queueHarness(t)
  const result = deferred<import('@/lib/image-tools').ProcessResult>()
  let signal: AbortSignal | undefined
  const process = t.mock.method(
    hook.Worker.prototype,
    'process',
    (
      _file: Blob,
      _options: import('@/lib/image-tools').ProcessOptions,
      nextSignal?: AbortSignal
    ) => {
      signal = nextSignal
      return result.promise
    }
  )
  const terminate = t.mock.method(hook.Worker.prototype, 'terminate')
  await act(async () =>
    hook.queue.addFiles([
      new File(['first'], 'first.png', { type: 'image/png' }),
      new File(['second'], 'second.png', { type: 'image/png' }),
    ])
  )
  let running!: Promise<void>
  await act(async () => {
    running = hook.queue.run(imagePlan)
  })
  await act(async () => {
    root!.unmount()
    root = null
  })
  assert.equal(signal?.aborted, true)
  assert.equal(terminate.mock.callCount(), 1)
  await act(async () => {
    result.resolve({ blob: new Blob(['ok']), bytes: 2, width: 10, height: 10 })
    await running
  })
  assert.equal(process.mock.callCount(), 1)
})

test('batch savings pair only successful input bytes with successful outputs', async (t) => {
  const hook = await queueHarness(t)
  t.mock.method(hook.Worker.prototype, 'process', async (file: File) => {
    if (file.name === 'bad.png') throw new Error('Decode failed')
    return { blob: new Blob(['ok']), bytes: 2, width: 10, height: 10 }
  })
  await act(async () =>
    hook.queue.addFiles([
      new File([new Uint8Array(1000)], 'bad.png', { type: 'image/png' }),
      new File([new Uint8Array(10)], 'good.png', { type: 'image/png' }),
    ])
  )
  await act(async () => hook.queue.run(imagePlan))
  assert.equal(hook.queue.totalInputBytes, 1010)
  assert.equal(hook.queue.successfulInputBytes, 10)
  assert.equal(hook.queue.totalOutputBytes, 2)
  assert.equal(hook.queue.failedCount, 1)
})

test('analytics exports ignore an old report completion without clearing the current action', async (t) => {
  const { AnalyzeWorkspace } = await import('@/components/analyze/AnalyzeWorkspace')
  const { analyticsReportSchema } = await import('@/lib/api/contracts/plan-analyze')
  const pendingOld = deferred<Response>(),
    pendingNew = deferred<Response>()
  const report = (id: string) =>
    analyticsReportSchema.parse({
      accountId: id,
      name: id,
      platform: 'x',
      profileUrl: '',
      query: { from: '2026-03-01', to: '2026-03-31', timeZone: 'UTC' },
      status: 'available',
      capabilities: { account: true, posts: true, import: true },
      checkedAt: null,
      coverageStart: null,
      asOf: '2026-04-01T00:00:00Z',
      metrics: {},
      posts: [],
      totalPosts: 1,
      nextCursor: null,
      hourly: [],
      settings: { version: 1, goal: null, publicToken: null },
      progress: { streak: 0, current: 0, required: 1, period: '2026-03-31' },
    })
  const response = (id: string) =>
    new Response(JSON.stringify(report(id)), { headers: { 'content-type': 'application/json' } })
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    const old = url.pathname.includes('/old')
    if (url.searchParams.get('limit') === '500')
      return old ? pendingOld.promise : pendingNew.promise
    return response(old ? 'old' : 'new')
  })
  const download = t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => {})
  const props = { initial: { from: '2026-03-01', to: '2026-03-31', timeZone: 'UTC' } }
  await mount(createElement(AnalyzeWorkspace, { ...props, publicToken: 'old' }))
  const button = () =>
    [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Export posts CSV'
    )!
  assert.ok(button())
  await act(async () => button().click())
  assert.equal(button().disabled, true)
  await act(async () =>
    root!.render(createElement(AnalyzeWorkspace, { ...props, publicToken: 'new' }))
  )
  assert.equal(button().disabled, false)
  await act(async () => button().click())
  await act(async () => pendingOld.resolve(response('old')))
  assert.equal(button().disabled, true)
  assert.equal(download.mock.callCount(), 0)
  await act(async () => pendingNew.resolve(response('new')))
  assert.equal(button().disabled, false)
  assert.equal(download.mock.callCount(), 1)
})

test('cancelling an image worker before ready cannot poison its replacement readiness', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ImageToolsWorkerClient } = await import('@/lib/image-tools/worker-client')
  const instances: FakeWorker[] = []
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    posts = 0
    constructor() {
      instances.push(this)
    }
    terminate() {}
    postMessage(message: { id: string }) {
      this.posts++
      this.onmessage?.({
        data: {
          id: message.id,
          success: true,
          result: { blob: new Blob(['ok']), bytes: 2, width: 1, height: 1 },
        },
      })
    }
    ready() {
      this.onmessage?.({ data: { type: 'ready' } })
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Worker', previous)
    else Reflect.deleteProperty(globalThis, 'Worker')
  })
  const client = new ImageToolsWorkerClient()
  const abort = new AbortController()
  const first = client.process(new Blob(['first']), imagePlan().options, abort.signal)
  abort.abort()
  client.terminate()
  await assert.rejects(first, { name: 'AbortError' })
  const replacement = client.process(new Blob(['second']), imagePlan().options)
  instances[1].ready()
  assert.equal((await replacement).bytes, 2)
  // An event queued by the dead worker must also be ignored.
  instances[0].onerror?.()
  t.mock.timers.tick(5_000)
  assert.equal((await client.process(new Blob(['third']), imagePlan().options)).bytes, 2)
  assert.equal(instances[1].posts, 2)
  client.terminate()
})

test('the paste dialog splits in a reused worker and enables Append only for the current text', async (t) => {
  const workers: FakeSplitWorker[] = []
  class FakeSplitWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    requests: unknown[][] = []
    terminated = false
    constructor() {
      workers.push(this)
    }
    postMessage(request: unknown[]) {
      this.requests.push(request)
    }
    terminate() {
      this.terminated = true
    }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeSplitWorker })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Worker', previous)
    else Reflect.deleteProperty(globalThis, 'Worker')
  })
  const { PasteThreadDialog } = await import('@/components/write/composer/paste-thread')
  await mount(
    createElement(PasteThreadDialog, {
      channel: 'x',
      editor: { current: null },
      limit: 280,
      onClose: () => {},
    })
  )
  const write = (text: string) =>
    act(async () => {
      const input = get<HTMLTextAreaElement>('textarea')
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text
      )
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  const reply = (worker: FakeSplitWorker, posts: string[]) =>
    act(async () => worker.onmessage?.({ data: { posts, error: '' } }))
  const append = () =>
    [...document.querySelectorAll('button')].find((button) =>
      /^(Append|Splitting)/.test(button.textContent!)
    )!
  await write('one two')
  await act(async () => get<HTMLButtonElement>('[role="checkbox"]').click())
  assert.deepEqual(workers[0].requests, [['one two', 'x', 280]])
  assert.equal(append().textContent, 'Splitting…')
  assert.equal(append().disabled, true)
  await reply(workers[0], ['one two'])
  assert.equal(append().textContent, 'Append 1 posts')
  assert.equal(append().disabled, false)

  // An idle worker takes the next edit; one still busy is replaced, and its
  // late answer, for older text, never enables Append.
  await write('one two three')
  assert.equal(workers.length, 1)
  assert.equal(append().textContent, 'Splitting…')
  await write('one two three four')
  assert.equal(workers[0].terminated, true)
  assert.deepEqual(workers[1].requests, [['one two three four', 'x', 280]])
  await reply(workers[0], ['stale'])
  assert.equal(append().textContent, 'Splitting…')
  await reply(workers[1], ['one two', 'three four'])
  assert.equal(append().textContent, 'Append 2 posts')
  assert.match(document.body.textContent!, /three four/)
  assert.doesNotMatch(document.body.textContent!, /stale/)

  // A worker that fails is reported and dropped, and closing the dialog stops the next.
  await write('five')
  await act(async () => workers[1].onerror?.())
  assert.equal(workers[1].terminated, true)
  assert.equal(get('[role="alert"]').textContent, 'The split preview could not load.')
  await write('six')
  assert.equal(workers.length, 3)
  await act(async () => root!.unmount())
  root = null
  assert.equal(workers[2].terminated, true)
})

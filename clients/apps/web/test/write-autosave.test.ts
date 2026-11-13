import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, before, test } from 'node:test'
import { act, createElement, StrictMode, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  DraftRequestError,
  draftsApi,
  type DraftSave,
  type DraftWire,
} from '@/lib/content-drafts/client'
import { useDraftDocument } from '@/components/write/composer/useDraftDocument'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
const globals = Object.getOwnPropertyDescriptors(globalThis)
before(() => {
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    navigator: { configurable: true, value: dom.window.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
})
after(() => {
  dom.window.close()
  for (const name of ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    if (globals[name]) Object.defineProperty(globalThis, name, globals[name])
    else Reflect.deleteProperty(globalThis, name)
  }
})

const draft = {
  id: 'draft',
  version: 1,
  collabGeneration: 1,
  title: 'Original',
  body: [],
  article: null,
  target: null,
  primaryPlatform: 'x',
  platformVersions: { schemaVersion: 1, versions: [] },
  channelConnectionIds: [],
  channelText: {},
  discussions: {},
} as unknown as DraftWire
const paragraph = (text: string) => [{ type: 'p', children: [{ text }] }]

async function mount(collaborating = false) {
  let state!: ReturnType<typeof useDraftDocument>
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  function Harness() {
    const current = useDraftDocument({
      canEdit: true,
      collaborating,
      draft,
      onSaved: () => undefined,
    })
    useLayoutEffect(() => {
      state = current
    })
    return null
  }
  await act(async () => root.render(createElement(StrictMode, null, createElement(Harness))))
  return {
    get state() {
      return state
    },
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('unmount saves the current text even before the debounce runs', async (t) => {
  const save = t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) => ({
    ...draft,
    ...input,
    version: 2,
  }))
  const editor = await mount()
  await act(async () => editor.state.update({ value: paragraph('Text before navigation') }))
  assert.equal(save.mock.callCount(), 0)
  assert.equal(editor.state.saveState, 'unsaved')
  await editor.unmount()
  assert.equal(save.mock.callCount(), 1)
  assert.equal(save.mock.calls[0].arguments[1].plainText, 'Text before navigation')
})

test('flush sees synchronous updates and serializes concurrent saves until the latest edit is persisted', async (t) => {
  const first = deferred<DraftWire>()
  const second = deferred<DraftWire>()
  const save = t.mock.method(draftsApi, 'save', (_id: string, input: DraftSave) =>
    input.baseVersion === 1 ? first.promise : second.promise
  )
  const editor = await mount()
  let flush!: Promise<void>
  await act(async () => {
    editor.state.update({ value: paragraph('First') })
    flush = editor.state.flush()
  })
  assert.equal(save.mock.callCount(), 1)
  assert.equal(save.mock.calls[0].arguments[1].plainText, 'First')
  let otherFlush!: Promise<void>
  let complete = false
  await act(async () => {
    editor.state.update({ value: paragraph('Latest'), title: 'Renamed' })
    otherFlush = editor.state.flush().then(() => {
      complete = true
    })
  })
  assert.equal(save.mock.callCount(), 1)
  await act(async () => first.resolve({ ...draft, version: 2 }))
  assert.equal(save.mock.callCount(), 2)
  assert.equal(save.mock.calls[1].arguments[1].baseVersion, 2)
  assert.equal(save.mock.calls[1].arguments[1].plainText, 'Latest')
  assert.equal(save.mock.calls[1].arguments[1].title, 'Renamed')
  assert.equal(complete, false)
  assert.notEqual(editor.state.saveState, 'saved')
  await act(async () => {
    second.resolve({ ...draft, version: 3 })
    await Promise.all([flush, otherFlush])
  })
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
  assert.equal(save.mock.callCount(), 2)
})

test('a failed flush blocks follow-up actions and retries the same document', async (t) => {
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, _input: DraftSave): Promise<DraftWire> => {
      throw new DraftRequestError('Unavailable', 503)
    }
  )
  const editor = await mount()
  await act(async () => {
    editor.state.update({ value: paragraph('Keep this text') })
    await assert.rejects(editor.state.flush(), /could not be saved/)
  })
  assert.equal(editor.state.saveState, 'error')
  save.mock.mockImplementation(async () => ({ ...draft, version: 2 }))
  await act(async () => editor.state.flush())
  assert.equal(save.mock.calls[1].arguments[1].plainText, 'Keep this text')
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
})

test('a failed conflict reload keeps the unsaved document available for retry', async (t) => {
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, _input: DraftSave): Promise<DraftWire> => {
      throw new DraftRequestError('Conflict', 409)
    }
  )
  t.mock.method(draftsApi, 'get', async () => {
    throw new Error('Offline')
  })
  const editor = await mount()
  await act(async () => {
    editor.state.update({ value: paragraph('Keep edits after conflict') })
    await assert.rejects(editor.state.flush(), /could not be saved/)
  })
  assert.equal(editor.state.saveState, 'error')
  save.mock.mockImplementation(async () => ({ ...draft, version: 2 }))
  await act(async () => editor.state.flush())
  assert.equal(save.mock.calls[1].arguments[1].plainText, 'Keep edits after conflict')
  await editor.unmount()
})

test('a transient server failure retries automatically with the latest title', async (t) => {
  let attempts = 0
  const save = t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) => {
    if (++attempts === 1) throw new DraftRequestError('Unavailable', 503)
    return { ...draft, ...input, version: 2 }
  })
  const editor = await mount()
  await act(async () => {
    editor.state.update({ title: 'Every letter survives' })
    await assert.rejects(editor.state.flush())
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
  assert.equal(save.mock.callCount(), 2)
  assert.equal(save.mock.calls[1].arguments[1].title, 'Every letter survives')
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
})

test('repeated failures back off three times, then leave a manual retry available', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const save = t.mock.method(draftsApi, 'save', async (): Promise<DraftWire> => {
    throw new DraftRequestError('Unavailable', 503)
  })
  const editor = await mount()
  await act(async () => {
    editor.state.update({ title: 'Keep retrying safely' })
    await assert.rejects(editor.state.flush())
  })
  for (const [index, delay] of [1000, 2000, 4000].entries()) {
    await act(async () => t.mock.timers.tick(delay))
    assert.equal(save.mock.callCount(), index + 2)
  }
  await act(async () => t.mock.timers.tick(8000))
  assert.equal(save.mock.callCount(), 4)
  assert.equal(editor.state.saveState, 'error')
  save.mock.mockImplementation(async () => ({ ...draft, version: 2 }))
  await act(async () => editor.state.flush())
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
})

test('failed edits survive unmount and reopening the draft', async (t) => {
  const save = t.mock.method(draftsApi, 'save', async (): Promise<DraftWire> => {
    throw new DraftRequestError('Unavailable', 503)
  })
  const editor = await mount()
  await act(async () =>
    editor.state.update({ title: 'Recover me', value: paragraph('Kept locally') })
  )
  await editor.unmount()
  const reopened = await mount()
  assert.equal(reopened.state.document.title, 'Recover me')
  assert.deepEqual(reopened.state.document.value, paragraph('Kept locally'))
  save.mock.mockImplementation(async () => ({ ...draft, version: 2 }))
  await act(async () => reopened.state.flush())
  await reopened.unmount()
})

test('fast title updates remain local while an earlier save response arrives', async (t) => {
  const pending = deferred<DraftWire>()
  let attempts = 0
  t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) =>
    ++attempts === 1 ? pending.promise : { ...draft, ...input, version: 3 }
  )
  const editor = await mount()
  let saving!: Promise<void>
  await act(async () => {
    editor.state.update({ title: 'A' })
    saving = editor.state.flush()
  })
  const title = '0123456789'.repeat(20)
  for (let end = 1; end <= title.length; end++) {
    await act(async () => editor.state.update({ title: title.slice(0, end) }))
  }
  await act(async () => {
    pending.resolve({ ...draft, title: 'A', version: 2 })
    await saving
  })
  assert.equal(editor.state.document.title, title)
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
})

test('a save conflict shows the newer version and keeps the local edit to restore on top of it', async (t) => {
  const theirs = { ...draft, version: 5, title: 'Theirs', body: paragraph('Their text') }
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, _input: DraftSave): Promise<DraftWire> => {
      throw new DraftRequestError('This draft was saved elsewhere.', 409)
    }
  )
  t.mock.method(draftsApi, 'get', async () => theirs)
  const editor = await mount()
  await act(async () => {
    editor.state.update({ value: paragraph('My text') })
    await assert.rejects(editor.state.flush(), /could not be saved/)
  })
  assert.deepEqual(editor.state.document.value, paragraph('Their text'))
  assert.deepEqual(editor.state.conflict?.value, paragraph('My text'))
  assert.equal(editor.state.saveState, 'saved')

  save.mock.mockImplementation(async () => ({ ...theirs, version: 6 }))
  await act(async () => editor.state.restoreConflict())
  assert.equal(editor.state.conflict, null)
  assert.deepEqual(editor.state.document.value, paragraph('My text'))
  await act(async () => editor.state.flush())
  assert.equal(save.mock.calls[1].arguments[1].baseVersion, 5)
  assert.equal(save.mock.calls[1].arguments[1].plainText, 'My text')
  assert.equal(editor.state.saveState, 'saved')
  await editor.unmount()
})

test('a conflicting edit survives reopening the draft until it is discarded', async (t) => {
  t.mock.method(draftsApi, 'save', async (): Promise<DraftWire> => {
    throw new DraftRequestError('This draft was saved elsewhere.', 409)
  })
  t.mock.method(draftsApi, 'get', async () => ({ ...draft, version: 3 }))
  const editor = await mount()
  await act(async () => {
    editor.state.update({ value: paragraph('Do not lose me') })
    await assert.rejects(editor.state.flush())
  })
  await editor.unmount()
  const reopened = await mount()
  assert.deepEqual(reopened.state.conflict?.value, paragraph('Do not lose me'))
  await act(async () => reopened.state.discardConflict())
  assert.equal(reopened.state.conflict, null)
  await reopened.unmount()
  const again = await mount()
  assert.equal(again.state.conflict, null)
  await again.unmount()
})

test('a sharing response adopts its clean document before a title-only save', async (t) => {
  const fresh = {
    ...draft,
    version: 4,
    body: paragraph('Teammate body'),
    channelConnectionIds: ['account-b'],
  }
  const save = t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) => ({
    ...fresh,
    ...input,
    version: 5,
  }))
  const editor = await mount()
  await act(async () => editor.state.setServer(fresh))
  assert.deepEqual(editor.state.document.value, fresh.body)
  await act(async () => {
    editor.state.update({ title: 'My title' })
    await editor.state.flush()
  })
  const sent = save.mock.calls[0].arguments[1]
  assert.equal(sent.baseVersion, 4)
  assert.deepEqual(sent.body, fresh.body)
  assert.deepEqual(sent.channelConnectionIds, ['account-b'])
  await act(async () => editor.state.setServer(draft))
  assert.equal(editor.state.versionRef.current, 5)
  assert.equal(editor.state.server.version, 5)
  await editor.unmount()
})

test('a newer metadata response cannot authorize a dirty local body', async (t) => {
  const fresh = { ...draft, version: 4, body: paragraph('Remote body') }
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, _input: DraftSave): Promise<DraftWire> => {
      throw new DraftRequestError('Conflict', 409)
    }
  )
  t.mock.method(draftsApi, 'get', async () => fresh)
  const editor = await mount()
  await act(async () => {
    editor.state.update({ value: paragraph('Local body') })
    editor.state.setServer(fresh)
    await assert.rejects(editor.state.flush())
  })
  assert.equal(save.mock.calls[0].arguments[1].baseVersion, 1)
  assert.deepEqual(editor.state.document.value, fresh.body)
  assert.deepEqual(editor.state.conflict?.value, paragraph('Local body'))
  await act(async () => editor.state.discardConflict())
  await editor.unmount()
})

test('metadata received during a save cannot advance the next write past unseen remote work', async (t) => {
  const pending = deferred<DraftWire>()
  const fresh = { ...draft, version: 4, body: paragraph('Teammate body') }
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, input: DraftSave): Promise<DraftWire> => {
      if (input.baseVersion === 1) return pending.promise
      throw new DraftRequestError('Conflict', 409)
    }
  )
  t.mock.method(draftsApi, 'get', async () => fresh)
  const editor = await mount()
  let saving!: Promise<void>
  await act(async () => {
    editor.state.update({ title: 'First' })
    saving = editor.state.flush()
  })
  await act(async () => {
    editor.state.setServer(fresh)
    editor.state.update({ title: 'Second' })
    pending.resolve({ ...draft, title: 'First', version: 2 })
    await assert.rejects(saving)
  })
  assert.equal(save.mock.calls[1].arguments[1].baseVersion, 2)
  assert.deepEqual(editor.state.document.value, fresh.body)
  assert.equal(editor.state.conflict?.title, 'Second')
  await act(async () => editor.state.discardConflict())
  await editor.unmount()
})

test('live autosave rebases independent remote title, destinations, article and manual versions', async (t) => {
  const remote = {
    ...draft,
    version: 2,
    title: 'Teammate title',
    channelConnectionIds: ['account-b'],
    platformVersions: {
      schemaVersion: 1,
      versions: [{ channel: 'linkedin', mode: 'manual', body: paragraph('Manual remote') }],
    },
  } as DraftWire
  let attempts = 0
  const save = t.mock.method(
    draftsApi,
    'save',
    async (_id: string, input: DraftSave): Promise<DraftWire> => {
      if (++attempts === 1) throw new DraftRequestError('Conflict', 409)
      return { ...remote, ...input, version: 3 } as DraftWire
    }
  )
  t.mock.method(draftsApi, 'get', async () => remote)
  const editor = await mount(true)
  await act(async () => {
    editor.state.update({ value: paragraph('Shared live body') })
    await editor.state.flush()
  })
  const sent = save.mock.calls[1].arguments[1]
  assert.equal(sent.baseVersion, 2)
  assert.equal(sent.title, 'Teammate title')
  assert.deepEqual(sent.channelConnectionIds, ['account-b'])
  assert.equal(sent.plainText, 'Shared live body')
  assert.deepEqual(sent.platformVersions, remote.platformVersions)
  assert.equal(editor.state.document.title, 'Teammate title')
  await editor.unmount()
})

test('live autosave preserves a local title while adopting remote destinations', async (t) => {
  let attempts = 0
  const remote = { ...draft, version: 2, channelConnectionIds: ['account-b'] }
  const save = t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) => {
    if (++attempts === 1) throw new DraftRequestError('Conflict', 409)
    return { ...remote, ...input, version: 3 }
  })
  t.mock.method(draftsApi, 'get', async () => remote)
  const editor = await mount(true)
  await act(async () => {
    editor.state.update({ title: 'Local title' })
    await editor.state.flush()
  })
  assert.equal(save.mock.calls[1].arguments[1].title, 'Local title')
  assert.deepEqual(save.mock.calls[1].arguments[1].channelConnectionIds, ['account-b'])
  await editor.unmount()
})

test('live autosave refuses overlapping titles and keeps both versions for a choice', async (t) => {
  const save = t.mock.method(draftsApi, 'save', async (): Promise<DraftWire> => {
    throw new DraftRequestError('Conflict', 409)
  })
  t.mock.method(draftsApi, 'get', async () => ({ ...draft, version: 2, title: 'Remote title' }))
  const editor = await mount(true)
  await act(async () => {
    editor.state.update({ title: 'Local title' })
    await assert.rejects(editor.state.flush())
  })
  assert.equal(save.mock.callCount(), 1)
  assert.equal(editor.state.document.title, 'Remote title')
  assert.equal(editor.state.conflict?.title, 'Local title')
  await act(async () => editor.state.discardConflict())
  await editor.unmount()
})

test('typing during a delayed conflict reload is preserved in the conflict copy', async (t) => {
  const pending = deferred<DraftWire>()
  t.mock.method(draftsApi, 'save', async (): Promise<DraftWire> => {
    throw new DraftRequestError('Conflict', 409)
  })
  t.mock.method(draftsApi, 'get', () => pending.promise)
  const editor = await mount()
  let saving!: Promise<void>
  await act(async () => {
    editor.state.update({ title: 'Before reload' })
    saving = editor.state.flush()
  })
  await act(async () => {
    editor.state.update({ title: 'Typed while loading' })
    pending.resolve({ ...draft, version: 2, title: 'Remote title' })
    await assert.rejects(saving)
  })
  assert.equal(editor.state.document.title, 'Remote title')
  assert.equal(editor.state.conflict?.title, 'Typed while loading')
  await act(async () => editor.state.discardConflict())
  await editor.unmount()
})

test('offline edits show as unsaved and every one saves when the network returns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let online = false
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  t.after(() => Reflect.deleteProperty(navigator, 'onLine'))
  const save = t.mock.method(draftsApi, 'save', async (_id: string, input: DraftSave) => {
    if (!online) throw new TypeError('Failed to fetch')
    return { ...draft, ...input, version: 2 }
  })
  // Let the autosave timer fire and its request settle.
  const autosave = () =>
    act(async () => {
      t.mock.timers.tick(800)
      await new Promise((resolve) => setImmediate(resolve))
    })
  const leaving = () => {
    const event = new dom.window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }
  const editor = await mount()
  await act(async () => editor.state.update({ title: 'Written offline' }))
  await autosave()
  assert.equal(save.mock.callCount(), 1)
  assert.equal(editor.state.saveState, 'offline')
  await act(async () => editor.state.update({ value: paragraph('A second offline edit') }))
  assert.equal(editor.state.saveState, 'unsaved')
  await autosave()
  assert.equal(editor.state.saveState, 'offline')
  assert.equal(leaving(), true, 'leaving with unsaved edits asks first')
  // Nothing retries until the network returns.
  await act(async () => t.mock.timers.tick(60_000))
  assert.equal(save.mock.callCount(), 2)
  online = true
  await act(async () => {
    window.dispatchEvent(new dom.window.Event('online'))
    await new Promise((resolve) => setImmediate(resolve))
  })
  assert.equal(save.mock.callCount(), 3)
  const saved = save.mock.calls[2].arguments[1]
  assert.equal(saved.title, 'Written offline')
  assert.deepEqual(saved.body, paragraph('A second offline edit'))
  assert.equal(saved.plainText, 'A second offline edit')
  assert.equal(editor.state.saveState, 'saved')
  assert.equal(leaving(), false)
  await editor.unmount()
})

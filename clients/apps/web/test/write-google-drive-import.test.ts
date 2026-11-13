import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { after, afterEach, before, test } from 'node:test'
import { act } from 'react'
import { jsx } from 'react/jsx-runtime'
import type { Root } from 'react-dom/client'

// The Drive import dialog renders in jsdom against stand-ins for Google's
// scripts and Drive: what a person sees, and what reaches the composer.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost',
})
const globals = Object.getOwnPropertyDescriptors(globalThis)
let pickerAnswer: Record<string, unknown> = {}
let tokenAnswer: 'token' | 'blocked' = 'token'
const drive: typeof fetch = async () => new Response(new Uint8Array([1, 2, 3]))
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
      'HTMLInputElement',
      'HTMLButtonElement',
      'HTMLTextAreaElement',
      'KeyboardEvent',
      'MouseEvent',
      'MutationObserver',
      'Node',
      'NodeFilter',
    ].map((name) => [name, dom.window[name]])
  ),
  requestAnimationFrame: (callback: (time: number) => void) =>
    setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  fetch: drive,
  IS_REACT_ACT_ENVIRONMENT: true,
}
const names = Object.keys(browser)
let ui: {
  createRoot: typeof import('react-dom/client').createRoot
  GoogleDriveImport: typeof import('@/components/write/composer/google-drive').GoogleDriveImport
}
before(async () => {
  for (const [name, value] of Object.entries(browser))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  // Google's scripts "load" at once; the globals below stand in for them.
  const head = dom.window.document.head
  head.appendChild = <T extends Node>(node: T) => {
    setTimeout(() => (node as unknown as { onload?: () => void }).onload?.(), 0)
    return node
  }
  class Builder {
    callback: (data: Record<string, unknown>) => void = () => {}
    addView = () => this
    enableFeature = () => this
    setAppId = () => this
    setDeveloperKey = () => this
    setMaxItems = () => this
    setOAuthToken = () => this
    setCallback = (callback: (data: Record<string, unknown>) => void) => {
      this.callback = callback
      return this
    }
    build = () => ({ setVisible: () => this.callback(pickerAnswer) })
  }
  Object.assign(dom.window, {
    gapi: { load: (_: string, options: { callback: () => void }) => options.callback() },
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            callback: (response: { access_token?: string }) => void
            error_callback?: (error: { type?: string }) => void
          }) => ({
            requestAccessToken: () =>
              tokenAnswer === 'token'
                ? config.callback({ access_token: 'fixture-token' })
                : config.error_callback?.({ type: 'popup_failed_to_open' }),
          }),
        },
      },
      picker: {
        Action: { CANCEL: 'cancel', PICKED: 'picked' },
        DocsView: class {
          setIncludeFolders = () => this
          setMimeTypes = () => this
        },
        Feature: { MULTISELECT_ENABLED: 'multiselect' },
        PickerBuilder: Builder,
        Response: { ACTION: 'action', DOCUMENTS: 'docs' },
      },
    },
  })
  const [{ createRoot }, { GoogleDriveImport }] = await Promise.all([
    import('react-dom/client'),
    import('@/components/write/composer/google-drive'),
  ])
  ui = { createRoot, GoogleDriveImport }
})
after(() => {
  dom.window.close()
  for (const name of names) {
    if (globals[name]) Object.defineProperty(globalThis, name, globals[name])
    else Reflect.deleteProperty(globalThis, name)
  }
})

let root: Root | null = null
afterEach(async () => {
  // Radix returns focus on a timer as a dialog closes; let it run before jsdom goes.
  await act(async () => {
    root?.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  root = null
})

const keys = { apiKey: 'key', appId: '123456789012', clientId: 'client' }

async function open(config: typeof keys | null) {
  const calls = { closed: 0, files: [] as File[][] }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  root = ui.createRoot(container)
  await act(async () => {
    root!.render(
      jsx(ui.GoogleDriveImport, {
        config,
        onClose: () => calls.closed++,
        onFiles: (files: File[]) => calls.files.push(files),
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  return calls
}

const button = (name: string) =>
  [...dom.window.document.querySelectorAll('button')].find(
    (element: HTMLButtonElement) => element.textContent === name
  ) as HTMLButtonElement | undefined

async function click(name: string) {
  // Effects run as the render settles; Google's stand-ins answer just after.
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  await act(async () => {
    button(name)!.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

test('without Shots’ Picker keys, Drive says it is not set up and only closes', async () => {
  const calls = await open(null)
  assert.match(dom.window.document.body.textContent, /Google Drive is not set up/)
  assert.equal(button('Choose from Google Drive'), undefined)
  await click('Close')
  assert.equal(calls.closed, 1)
})

test('a pick downloads from Drive and reaches the composer’s upload', async () => {
  tokenAnswer = 'token'
  pickerAnswer = {
    action: 'picked',
    docs: [{ id: 'f1', mimeType: 'image/png', name: 'drive.png', sizeBytes: 3 }],
  }
  const calls = await open(keys)
  await click('Choose from Google Drive')
  assert.deepEqual(
    calls.files.map((files) => files.map((file) => [file.name, file.type, file.size])),
    [[['drive.png', 'image/png', 3]]]
  )
  assert.equal(calls.closed, 1)
})

test('cancelling the Picker leaves the dialog open and uploads nothing', async () => {
  tokenAnswer = 'token'
  pickerAnswer = { action: 'cancel' }
  const calls = await open(keys)
  await click('Choose from Google Drive')
  assert.deepEqual(calls.files, [])
  assert.equal(calls.closed, 0)
  assert.equal(button('Choose from Google Drive')?.disabled, false)
})

test('a blocked sign-in popup says to allow pop-ups', async () => {
  tokenAnswer = 'blocked'
  const calls = await open(keys)
  await click('Choose from Google Drive')
  assert.match(dom.window.document.body.textContent, /Allow pop-ups for Shots/)
  assert.deepEqual(calls.files, [])
})

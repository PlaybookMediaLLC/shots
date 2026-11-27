import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INLINE_SUGGESTIONS_STORAGE_KEY,
  readInlineSuggestionsEnabled,
  subscribeInlineSuggestions,
  writeInlineSuggestionsEnabled,
} from '@/lib/write/inline-suggestions'

test('inline suggestions default on, stay fresh across unmounted storage edits, and handle quota/denied errors', () => {
  const store = new Map<string, string>()
  const target = new EventTarget()
  const originalWindow = globalThis.window
  let throwOnRead = false
  let throwOnWrite = false
  let throwOnStorageGetter = false

  const storageImpl = {
    getItem: (key: string) => {
      if (throwOnRead) throw new Error('Storage denied')
      return store.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (throwOnWrite) throw new Error('Quota exceeded')
      store.set(key, value)
    },
  }

  const fakeWindow = Object.defineProperty(target, 'localStorage', {
    configurable: true,
    get() {
      if (throwOnStorageGetter) throw new Error('Access blocked')
      return storageImpl
    },
  })

  ;(globalThis as { window?: unknown }).window = fakeWindow
  try {
    assert.equal(readInlineSuggestionsEnabled(), true)

    // Corrupted/unexpected stored value defaults safely to true.
    store.set(INLINE_SUGGESTIONS_STORAGE_KEY, 'corrupted')
    assert.equal(readInlineSuggestionsEnabled(), true)
    store.clear()

    let notifications = 0
    const unsubscribe = subscribeInlineSuggestions(() => {
      notifications += 1
    })

    writeInlineSuggestionsEnabled(false)
    assert.equal(store.get(INLINE_SUGGESTIONS_STORAGE_KEY), 'off')
    assert.equal(readInlineSuggestionsEnabled(), false)
    assert.equal(notifications, 1)

    // Write-only QuotaExceededError while getItem still returns stale 'off': toggle still flips on.
    throwOnWrite = true
    writeInlineSuggestionsEnabled(true)
    assert.equal(store.get(INLINE_SUGGESTIONS_STORAGE_KEY), 'off')
    assert.equal(readInlineSuggestionsEnabled(), true)
    assert.equal(notifications, 2)
    throwOnWrite = false

    // Cross-tab storage event for our key notifies subscribers; unrelated key does not.
    fakeWindow.dispatchEvent(Object.assign(new Event('storage'), { key: 'other-key' }))
    assert.equal(notifications, 2)

    store.set(INLINE_SUGGESTIONS_STORAGE_KEY, 'off')
    fakeWindow.dispatchEvent(
      Object.assign(new Event('storage'), { key: INLINE_SUGGESTIONS_STORAGE_KEY })
    )
    assert.equal(notifications, 3)
    assert.equal(readInlineSuggestionsEnabled(), false)

    // Unsubscribed/unmounted SPA navigation still reads fresh localStorage written by another tab.
    unsubscribe()
    store.set(INLINE_SUGGESTIONS_STORAGE_KEY, 'on')
    assert.equal(readInlineSuggestionsEnabled(), true)

    // Throwing localStorage property getter still falls back cleanly in-tab.
    throwOnStorageGetter = true
    writeInlineSuggestionsEnabled(false)
    assert.equal(readInlineSuggestionsEnabled(), false)
    writeInlineSuggestionsEnabled(true)
    assert.equal(readInlineSuggestionsEnabled(), true)
    throwOnStorageGetter = false

    // Both read and write throwing still allows toggling in-tab.
    throwOnRead = true
    throwOnWrite = true
    writeInlineSuggestionsEnabled(false)
    assert.equal(readInlineSuggestionsEnabled(), false)
  } finally {
    throwOnRead = false
    throwOnWrite = false
    throwOnStorageGetter = false
    store.clear()
    writeInlineSuggestionsEnabled(true)
    ;(globalThis as { window?: unknown }).window = originalWindow
  }
})

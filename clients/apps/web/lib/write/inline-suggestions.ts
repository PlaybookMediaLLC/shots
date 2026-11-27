import * as React from 'react'

/**
 * Browser preference for inline AI ghost-text suggestions in the post editor.
 * Defaults to enabled; turning it off persists across sessions and stops the
 * editor from requesting inline completions.
 */

export const INLINE_SUGGESTIONS_STORAGE_KEY = 'shots.write.inline-suggestions'
const INLINE_SUGGESTIONS_EVENT = 'shots:write-inline-suggestions-change'

// Only populated when localStorage is unavailable or setItem throws (e.g. QuotaExceededError).
let fallbackEnabled: boolean | null = null

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Whether inline AI suggestions are enabled for this browser (defaults to true). */
export function readInlineSuggestionsEnabled(): boolean {
  if (typeof window === 'undefined') return true
  if (fallbackEnabled !== null) return fallbackEnabled
  try {
    const stored = storage()?.getItem(INLINE_SUGGESTIONS_STORAGE_KEY)
    if (stored === 'off') return false
    if (stored === 'on') return true
  } catch {
    // Storage refused; default to enabled until toggled.
  }
  return true
}

/** Saves the writer's inline AI suggestions preference and notifies open editors. */
export function writeInlineSuggestionsEnabled(enabled: boolean): void {
  const target = storage()
  if (!target) {
    fallbackEnabled = enabled
  } else {
    try {
      target.setItem(INLINE_SUGGESTIONS_STORAGE_KEY, enabled ? 'on' : 'off')
      fallbackEnabled = null
    } catch {
      // Storage refused or full; keep the choice in memory for this tab.
      fallbackEnabled = enabled
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(INLINE_SUGGESTIONS_EVENT))
  }
}

/** Subscribes to same-tab and cross-tab changes to the inline suggestions toggle. */
export function subscribeInlineSuggestions(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === INLINE_SUGGESTIONS_STORAGE_KEY) {
      fallbackEnabled = null
      onChange()
    }
  }
  window.addEventListener(INLINE_SUGGESTIONS_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(INLINE_SUGGESTIONS_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Reactive inline AI suggestions toggle backed by localStorage. */
export function useInlineSuggestionsEnabled(): readonly [boolean, (enabled: boolean) => void] {
  const enabled = React.useSyncExternalStore(
    subscribeInlineSuggestions,
    readInlineSuggestionsEnabled,
    () => true
  )
  return [enabled, writeInlineSuggestionsEnabled] as const
}
